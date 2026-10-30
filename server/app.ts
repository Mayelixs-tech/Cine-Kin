import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { rateLimiter } from "hono-rate-limiter";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import {
  createOAuthCallbackHandler,
  createOAuthStartHandler,
} from "./kimi/auth";
import { Paths } from "@contracts/constants";
import {
  hasAllowedOrigin,
  isDeviceApiTrpcRequest,
  isHumanLoginTrpcRequest,
  isSensitiveTrpcBatch,
  sensitiveProcedureKey,
} from "./lib/trpc-security";
import { env } from "./lib/env";
import { getTrustedClientIp } from "./lib/client-ip";
import { createRateLimitStore } from "./lib/database-rate-limit-store";
import { createReadinessHandler } from "./lib/health";
import { errorSummary, logEvent } from "./lib/observability";

type AppEnv = {
  Bindings: HttpBindings;
  Variables: { requestId: string };
};

// The Hono application, with no server binding. Two entry points import it:
//   - server/boot.ts  → attaches @hono/node-server for a persistent Node host
//     (npm start / the esbuild bundle).
//   - server/index.ts → wraps it with hono/vercel as a single Vercel Serverless
//     Function.
const app = new Hono<AppEnv>();

// Per-IP quotas (15-minute windows, one counter per IP AND per procedure).
// Human logins keep a strict quota. The CinéKin Player device API gets a
// separate, generous one: behind a mobile carrier NAT, dozens of legitimate
// devices share one public IP. If legitimate HTTP 429 responses show up in
// production, raise APP_DEVICE_RATE_LIMIT_PER_IP.
const HUMAN_LOGIN_RATE_LIMIT_PER_IP = 10;
export const APP_DEVICE_RATE_LIMIT_PER_IP = 300;
const SENSITIVE_RATE_LIMIT_WINDOW_MS = 15 * 60_000;

// Extract the client IP used as the rate-limiter key. Forwarded headers are
// ignored unless the deployment explicitly trusts a known number of proxies.
function getClientIp(c: Context<AppEnv>): string {
  return getTrustedClientIp({
    forwardedFor: c.req.header("x-forwarded-for"),
    remoteAddress: c.env?.incoming?.socket?.remoteAddress,
    trustProxy: env.trustProxy,
    trustedHops: env.trustProxyHops,
  });
}

// One correlation id per request, emitted both in the response and as JSON
// logs. Raw request bodies, cookies and authorization data are never logged.
app.use("*", async (c, next) => {
  const requestId = randomUUID();
  const startedAt = performance.now();
  c.set("requestId", requestId);
  c.header("X-Request-ID", requestId);
  await next();
  logEvent("info", "http_request", {
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Math.round(performance.now() - startedAt),
  });
});

app.onError((error, c) => {
  const requestId = c.get("requestId") || randomUUID();
  logEvent("error", "unhandled_request_error", {
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    ...errorSummary(error),
  });
  c.header("X-Request-ID", requestId);
  return c.json({ error: "Erreur interne.", requestId }, 500);
});

// Security headers on every response (X-Frame-Options, nosniff, HSTS,
// Referrer-Policy, …) plus a tailored Content-Security-Policy that
// allow-lists exactly the external origins the app actually uses and
// nothing else:
//   - Google Fonts  → styles from fonts.googleapis.com, files from fonts.gstatic.com
//   - external avatar images (user.avatar from the Kimi profile) → img-src https:
//
// React/Framer Motion still use inline style attributes, so style-src keeps
// 'unsafe-inline'. index.html no longer contains inline scripts, allowing a
// strict script-src without 'unsafe-inline'.
//
// No CORS middleware exists: the frontend and the tRPC API are served from
// the same origin, so there is no CORS/secureHeaders ordering concern.
app.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
    },
  })
);

// tRPC carries JSON only; there is no upload endpoint. Keeping this small
// limits memory pressure before input validation.
app.use(bodyLimit({ maxSize: 1024 * 1024 }));

app.use("/api/trpc/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "POST") return next();
  if (!hasAllowedOrigin(c.req.raw.headers, c.req.url, env.trustProxy)) {
    return c.json({ error: "Origine de requête non autorisée." }, 403);
  }
  return next();
});

// Device API responses carry a PIN-authenticated status and, for
// devicePlaylists, credentials: never cacheable, including errors (400 input
// validation, 401, 429) that are answered before the resolvers run.
app.use("/api/trpc/*", async (c, next) => {
  await next();
  if (isDeviceApiTrpcRequest(c.req.url)) {
    c.res.headers.set("Cache-Control", "no-store");
  }
});

// A single tRPC HTTP batch used to execute many password guesses while the
// HTTP rate limiter counted only one request. Sensitive public procedures must
// therefore use the non-batched transport.
app.use("/api/trpc/*", async (c, next) => {
  if (isSensitiveTrpcBatch(c.req.url)) {
    return c.json(
      {
        error:
          "Le batching tRPC est interdit pour les opérations d'authentification.",
      },
      400
    );
  }
  return next();
});

// Dedicated protection for human login procedures. It is deliberately
// stricter than the general API quota. Production uses the shared MySQL store
// so all serverless instances enforce one global counter.
app.use(
  "/api/trpc/*",
  rateLimiter<AppEnv>({
    windowMs: SENSITIVE_RATE_LIMIT_WINDOW_MS,
    limit: HUMAN_LOGIN_RATE_LIMIT_PER_IP,
    standardHeaders: "draft-6",
    requestPropertyName: "authRateLimit",
    requestStorePropertyName: "authRateLimitStore",
    store: createRateLimitStore<AppEnv>("auth"),
    skip: c => !isHumanLoginTrpcRequest(c.req.url),
    keyGenerator: c => `${getClientIp(c)}:${sensitiveProcedureKey(c.req.url)}`,
    message: { error: "Trop de tentatives. Réessayez dans 15 minutes." },
  })
);

// Device API (app.registerDevice, app.deviceStatus, app.devicePlaylists):
// generous per-IP ceiling. PIN brute force is limited per MAC inside the
// resolvers (server/app-device-router.ts), independently of the IP.
app.use(
  "/api/trpc/*",
  rateLimiter<AppEnv>({
    windowMs: SENSITIVE_RATE_LIMIT_WINDOW_MS,
    limit: APP_DEVICE_RATE_LIMIT_PER_IP,
    standardHeaders: "draft-6",
    requestPropertyName: "appDeviceRateLimit",
    requestStorePropertyName: "appDeviceRateLimitStore",
    store: createRateLimitStore<AppEnv>("app-device"),
    skip: c => !isDeviceApiTrpcRequest(c.req.url),
    keyGenerator: c => `${getClientIp(c)}:${sensitiveProcedureKey(c.req.url)}`,
    message: { error: "Trop de requêtes. Réessayez dans 15 minutes." },
  })
);

// General tRPC rate limiting. Production uses the same shared MySQL store with
// a distinct key prefix; local development keeps the in-memory implementation.
app.use(
  "/api/trpc/*",
  rateLimiter<AppEnv>({
    windowMs: 60_000, // 1 minute
    limit: 100, // max requests per IP per window
    standardHeaders: "draft-6",
    keyGenerator: getClientIp,
    store: createRateLimitStore<AppEnv>("api"),
  })
);

app.get("/api/health/live", c => {
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true });
});
app.get("/api/health/ready", createReadinessHandler());
app.get(Paths.oauthStart, createOAuthStartHandler());
app.get(Paths.oauthCallback, createOAuthCallbackHandler());
app.use("/api/trpc/*", async c => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    // The trusted client IP is computed here (it needs the Node socket) and
    // handed to the resolvers, e.g. for the new-device-per-IP limit.
    createContext: opts => createContext(opts, { clientIp: getClientIp(c) }),
  });
});
app.all("/api/*", c => c.json({ error: "Not Found" }, 404));

export default app;

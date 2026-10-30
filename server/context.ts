import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import * as cookie from "cookie";
import { and, eq, isNotNull } from "drizzle-orm";
import type { User, AppClient, Reseller } from "@db/schema";
import { appClients, resellers } from "@db/schema";
import {
  ClientSession,
  ResellerSession,
  AdminSession,
} from "@contracts/constants";
import { authenticateRequest } from "./kimi/auth";
import {
  verifyClientSession,
  verifyResellerSession,
  verifyAdminSession,
  sessionVersionForCredential,
  sessionVersionMatches,
} from "./lib/app-sessions";
import { env } from "./lib/env";
import { getDb } from "./queries/connection";

// Synthetic admin identity for the password-based admin session (no Kimi user
// row). It satisfies the User shape and carries role "admin" so adminQuery and
// auth.me treat it exactly like an OAuth admin.
const PASSWORD_ADMIN_USER: User = {
  id: 0,
  unionId: "password-admin",
  name: "Administrateur",
  email: null,
  avatar: null,
  role: "admin",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastSignInAt: new Date(0),
};

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  // Trusted client IP (see server/lib/client-ip.ts). Absent in unit tests.
  clientIp?: string;
  user?: User;
  appClient?: AppClient;
  reseller?: Reseller;
};

async function loadAppClient(
  appClientId: number,
  sessionVersion: string
): Promise<AppClient | undefined> {
  const rows = await getDb()
    .select()
    .from(appClients)
    .where(and(eq(appClients.id, appClientId), isNotNull(appClients.claimedAt)))
    .limit(1);
  const client = rows.at(0);
  if (
    !client ||
    !sessionVersionMatches(
      sessionVersion,
      sessionVersionForCredential(client.pinHash ?? "")
    )
  ) {
    return undefined;
  }
  return client;
}

async function loadReseller(
  resellerId: number,
  sessionVersion: string
): Promise<Reseller | undefined> {
  const rows = await getDb()
    .select()
    .from(resellers)
    .where(eq(resellers.id, resellerId))
    .limit(1);
  const reseller = rows.at(0);
  if (
    !reseller ||
    !sessionVersionMatches(
      sessionVersion,
      sessionVersionForCredential(reseller.passwordHash)
    )
  ) {
    return undefined;
  }
  return reseller;
}

export async function createContext(
  opts: FetchCreateContextFnOptions,
  extra: { clientIp?: string } = {}
): Promise<TrpcContext> {
  const ctx: TrpcContext = {
    req: opts.req,
    resHeaders: opts.resHeaders,
    clientIp: extra.clientIp,
  };

  // Admin (Kimi) session — optional.
  try {
    ctx.user = await authenticateRequest(opts.req.headers);
  } catch {
    // Authentication is optional here
  }

  // Application-licence sessions — parsed only when their cookie is present.
  const cookies = cookie.parse(opts.req.headers.get("cookie") || "");

  // Password-based admin session — grants an admin identity when no Kimi user
  // is present.
  if (!ctx.user) {
    const adminToken = cookies[AdminSession.cookieName];
    if (adminToken) {
      try {
        const claim = await verifyAdminSession(adminToken);
        if (
          claim &&
          env.adminPassword &&
          sessionVersionMatches(
            claim.sessionVersion,
            sessionVersionForCredential(env.adminPassword)
          )
        ) {
          ctx.user = PASSWORD_ADMIN_USER;
        }
      } catch {
        // Optional
      }
    }
  }

  const clientToken = cookies[ClientSession.cookieName];
  if (clientToken) {
    try {
      const claim = await verifyClientSession(clientToken);
      if (claim) {
        ctx.appClient = await loadAppClient(
          claim.appClientId,
          claim.sessionVersion
        );
      }
    } catch {
      // Optional
    }
  }

  const resellerToken = cookies[ResellerSession.cookieName];
  if (resellerToken) {
    try {
      const claim = await verifyResellerSession(resellerToken);
      if (claim) {
        ctx.reseller = await loadReseller(
          claim.resellerId,
          claim.sessionVersion
        );
      }
    } catch {
      // Optional
    }
  }

  return ctx;
}

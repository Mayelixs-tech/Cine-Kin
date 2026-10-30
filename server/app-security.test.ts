import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.APP_SECRET = "test-app-secret-0123456789-abcdefghij";
  process.env.SESSION_SECRET = "test-session-secret-0123456789-abcdefghij";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.TRUST_PROXY = "true";
});

import app, { APP_DEVICE_RATE_LIMIT_PER_IP } from "./app";
import { appRouter } from "./router";

beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function post(
  url: string,
  ip: string,
  extraHeaders: Record<string, string> = {}
) {
  return app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...extraHeaders,
    },
    body: "{}",
  });
}

describe("Hono authentication perimeter", () => {
  it("serves a liveness probe with a correlation id and strict script CSP", async () => {
    const response = await app.request("https://cine.test/api/health/live");
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("blocks a batched admin-login request before tRPC executes it", async () => {
    const response = await post(
      "http://cine.test/api/trpc/auth.adminLogin,auth.adminLogin?batch=1",
      "198.51.100.10"
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("batching"),
    });
  });

  it("blocks cross-origin browser mutations", async () => {
    const response = await post(
      "http://cine.test/api/trpc/auth.adminLogin",
      "198.51.100.11",
      {
        host: "cine.test",
        origin: "https://attacker.test",
      }
    );
    expect(response.status).toBe(403);
  });

  it("applies the dedicated ten-attempt quota to one sensitive procedure", async () => {
    const url = "http://cine.test/api/trpc/auth.adminLogin";
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await post(url, "198.51.100.12");
      expect(response.status).not.toBe(429);
    }
    const blocked = await post(url, "198.51.100.12");
    expect(blocked.status).toBe(429);
  });
});

describe("CinéKin Player device API perimeter", () => {
  it("exposes deviceStatus and devicePlaylists as mutations so the PIN never goes in a URL", () => {
    // At runtime tRPC exposes a flat map keyed by the dotted procedure path.
    const procedures = appRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string } }
    >;
    expect(procedures["app.deviceStatus"]._def.type).toBe("mutation");
    expect(procedures["app.devicePlaylists"]._def.type).toBe("mutation");
    expect(procedures["app.registerDevice"]._def.type).toBe("mutation");
  });

  it.each(["app.deviceStatus", "app.devicePlaylists", "app.registerDevice"])(
    "does not apply the strict ten-attempt quota to %s",
    async name => {
      const url = `http://cine.test/api/trpc/${name}`;
      for (let attempt = 1; attempt <= 15; attempt += 1) {
        const response = await post(url, "198.51.100.40");
        expect(response.status).not.toBe(429);
      }
    }
  );

  it("caps the device API per IP with its own quota", async () => {
    // The general limiter (100/min/IP) shares the IP key and would answer 429
    // first in a burst: the clock is moved forward between bursts so that
    // only the 15-minute device quota is exercised here.
    const url = "http://cine.test/api/trpc/app.deviceStatus";
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let attempt = 1; attempt <= APP_DEVICE_RATE_LIMIT_PER_IP; attempt += 1) {
        vi.setSystemTime(start + Math.floor(attempt / 90) * 61_000);
        const response = await post(url, "198.51.100.41");
        expect(response.status).not.toBe(429);
      }
      const blocked = await post(url, "198.51.100.41");
      expect(blocked.status).toBe(429);
      await expect(blocked.json()).resolves.toMatchObject({
        error: "Trop de requêtes. Réessayez dans 15 minutes.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks every device API response as non-cacheable, errors included", async () => {
    const response = await post(
      "http://cine.test/api/trpc/app.deviceStatus",
      "198.51.100.43"
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the superjson envelope used by the documented contract", async () => {
    const response = await app.request(
      "http://cine.test/api/trpc/app.deviceStatus",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.44",
        },
        body: JSON.stringify({ mac: "6E:63:F8:C4:03:0A", pin: "123456" }),
      }
    );
    expect(response.status).toBe(400);
  });

  it("blocks a batched device request before tRPC executes it", async () => {
    const response = await post(
      "http://cine.test/api/trpc/app.deviceStatus,app.devicePlaylists?batch=1",
      "198.51.100.42"
    );
    expect(response.status).toBe(400);
  });
});

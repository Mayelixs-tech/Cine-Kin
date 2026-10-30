// Human logins (admin, reseller, client portal): strict per-IP quota.
const HUMAN_LOGIN_PROCEDURES = new Set([
  "auth.adminLogin",
  "clientPortal.login",
  "reseller.login",
]);

// Device API called by the CinéKin Player app. Many legitimate devices can
// share one IP behind a mobile carrier NAT, so these get their own, more
// generous per-IP quota; brute force is stopped by the per-MAC lockout instead.
const DEVICE_API_PROCEDURES = new Set([
  "app.registerDevice",
  "app.deviceStatus",
  "app.devicePlaylists",
]);

// Every public procedure that checks a secret: tRPC batching is forbidden for
// all of them, otherwise one HTTP request could carry many guesses.
const SENSITIVE_PUBLIC_PROCEDURES = new Set([
  ...HUMAN_LOGIN_PROCEDURES,
  ...DEVICE_API_PROCEDURES,
]);

function asUrl(input: string | URL): URL {
  return input instanceof URL ? input : new URL(input, "http://localhost");
}

export function trpcProcedureNames(input: string | URL): string[] {
  const url = asUrl(input);
  const marker = "/api/trpc/";
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex < 0) return [];

  const encodedPath = url.pathname.slice(markerIndex + marker.length);
  if (!encodedPath) return [];

  try {
    return decodeURIComponent(encodedPath)
      .split(",")
      .map(name => name.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function isSensitiveTrpcRequest(input: string | URL): boolean {
  return trpcProcedureNames(input).some(name =>
    SENSITIVE_PUBLIC_PROCEDURES.has(name)
  );
}

export function isHumanLoginTrpcRequest(input: string | URL): boolean {
  return trpcProcedureNames(input).some(name =>
    HUMAN_LOGIN_PROCEDURES.has(name)
  );
}

export function isDeviceApiTrpcRequest(input: string | URL): boolean {
  return trpcProcedureNames(input).some(name =>
    DEVICE_API_PROCEDURES.has(name)
  );
}

export function isSensitiveTrpcBatch(input: string | URL): boolean {
  const url = asUrl(input);
  if (!isSensitiveTrpcRequest(url)) return false;
  return (
    url.searchParams.get("batch") === "1" ||
    trpcProcedureNames(url).length !== 1
  );
}

// Browser mutations are same-origin. Native TV/box clients generally omit the
// Origin header and remain supported; browsers sending an Origin must match the
// effective Host (including the forwarded host on Vercel/proxies).
export function hasAllowedOrigin(
  headers: Headers,
  requestUrl: string | URL,
  trustProxy = false
): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;

  const request = asUrl(requestUrl);
  const forwardedHost = trustProxy
    ? headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  const forwardedProtocol = trustProxy
    ? headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
    : undefined;
  const directHost = headers.get("host")?.split(",")[0]?.trim();
  const expectedHost = forwardedHost || directHost || request.host;
  const expectedProtocol = forwardedProtocol
    ? `${forwardedProtocol.replace(/:$/, "")}:`
    : request.protocol;

  try {
    const expectedOrigin = new URL(`${expectedProtocol}//${expectedHost}`)
      .origin;
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function sensitiveProcedureKey(input: string | URL): string {
  return (
    trpcProcedureNames(input).find(name =>
      SENSITIVE_PUBLIC_PROCEDURES.has(name)
    ) ?? "unknown"
  );
}

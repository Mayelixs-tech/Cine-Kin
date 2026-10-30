import { TRPCError } from "@trpc/server";
import type { Store } from "hono-rate-limiter";
import { createRateLimitStore } from "./database-rate-limit-store";

// ---------------------------------------------------------------------------
// Tunable limits for the CinéKin Player device API.
// ---------------------------------------------------------------------------

// Per-MAC PIN lockout: after DEVICE_PIN_MAX_FAILURES wrong PINs within
// DEVICE_PIN_FAILURE_WINDOW_MS, the MAC is locked for DEVICE_LOCK_DURATION_MS,
// whatever the IP. Known trade-off: someone who knows a MAC can lock it for
// 15 minutes by sending wrong PINs.
export const DEVICE_PIN_MAX_FAILURES = 5;
export const DEVICE_PIN_FAILURE_WINDOW_MS = 15 * 60_000;
export const DEVICE_LOCK_DURATION_MS = 15 * 60_000;

// New rows created by app.registerDevice per client IP. Slows down filling
// the database and manufacturing free trials.
export const NEW_DEVICES_PER_IP_LIMIT = 100;
export const NEW_DEVICES_PER_IP_WINDOW_MS = 60 * 60_000;

export const DEVICE_LOCKED_MESSAGE =
  "Trop de tentatives pour cet appareil. Réessayez dans 15 minutes.";
export const NEW_DEVICE_QUOTA_MESSAGE =
  "Trop de nouveaux appareils enregistrés depuis ce réseau. Réessayez plus tard.";

// Same shared store as the HTTP rate limiters (MySQL in production, memory in
// development and tests), with dedicated key prefixes.
function createCounter(prefix: string, windowMs: number): Store {
  const store = createRateLimitStore(prefix);
  // Both store implementations only read `windowMs` from these options.
  store.init?.({ windowMs } as Parameters<NonNullable<Store["init"]>>[0]);
  return store;
}

export const devicePinFailureStore = createCounter(
  "device-pin-failures",
  DEVICE_PIN_FAILURE_WINDOW_MS
);
export const deviceLockStore = createCounter(
  "device-pin-lock",
  DEVICE_LOCK_DURATION_MS
);
export const newDevicesPerIpStore = createCounter(
  "app-new-devices",
  NEW_DEVICES_PER_IP_WINDOW_MS
);

// Hits still inside their window. The in-memory store can return a counter
// whose window already ended, so the reset time is checked here.
async function activeHits(store: Store, key: string): Promise<number> {
  const info = await store.get?.(key);
  if (!info) return 0;
  if (info.resetTime && info.resetTime.getTime() <= Date.now()) return 0;
  return info.totalHits;
}

// `mac` must be the canonical form (macAddressSchema output) so that every
// spelling of one device shares a single counter.
export async function assertDeviceNotLocked(mac: string): Promise<void> {
  if ((await activeHits(deviceLockStore, mac)) > 0) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: DEVICE_LOCKED_MESSAGE,
    });
  }
}

export async function recordDevicePinFailure(mac: string): Promise<void> {
  const failures = await devicePinFailureStore.increment(mac);
  if (failures.totalHits >= DEVICE_PIN_MAX_FAILURES) {
    // Start a fresh, full-length lock from the failure that triggered it.
    await deviceLockStore.resetKey(mac);
    await deviceLockStore.increment(mac);
    await devicePinFailureStore.resetKey(mac);
  }
}

export async function clearDevicePinFailures(mac: string): Promise<void> {
  await devicePinFailureStore.resetKey(mac);
}

function ipKey(clientIp: string | undefined): string {
  return clientIp || "unknown";
}

export async function assertNewDeviceQuota(
  clientIp: string | undefined
): Promise<void> {
  const created = await activeHits(newDevicesPerIpStore, ipKey(clientIp));
  if (created >= NEW_DEVICES_PER_IP_LIMIT) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: NEW_DEVICE_QUOTA_MESSAGE,
    });
  }
}

export async function recordNewDevice(
  clientIp: string | undefined
): Promise<void> {
  await newDevicesPerIpStore.increment(ipKey(clientIp));
}

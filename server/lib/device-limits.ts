import { TRPCError } from "@trpc/server";
import type { Store } from "hono-rate-limiter";
import { createRateLimitStore } from "./database-rate-limit-store";

// ---------------------------------------------------------------------------
// Tunable limits for the CinéKin Player device API.
// ---------------------------------------------------------------------------

// Per-MAC secret lockout (PIN or one-time activation code), whatever the IP:
// at most DEVICE_PIN_MAX_FAILURES failed attempts per
// DEVICE_PIN_FAILURE_WINDOW_MS; the next attempt locks the MAC for
// DEVICE_LOCK_DURATION_MS. Known trade-offs: someone who knows a MAC can lock
// it for 15 minutes by sending wrong PINs, and a legitimate request that
// arrives in the middle of an attack burst can be refused.
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

export const deviceAttemptStore = createCounter(
  "device-pin-attempts",
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

// "Reserve before verifying": every secret check on a MAC first takes a slot
// in the attempt counter, BEFORE the row is read and before scrypt runs. A
// check-then-record design lets parallel requests all pass the check before a
// single failure is recorded (100 parallel guesses instead of 5). Here the
// increment is atomic (synchronous in memory, one INSERT … ON DUPLICATE KEY
// UPDATE in MySQL), so at most DEVICE_PIN_MAX_FAILURES requests per window
// ever reach the secret check, sequential or parallel. The MySQL store reads
// the total back in a second statement, so during a burst a request may see
// a total inflated by others and be refused: it errs on the safe side only.
//
// A failure has nothing more to record: its slot is already taken. A success
// gives its own slot back with refundDeviceAttempt.
//
// `mac` must be the canonical form (macAddressSchema output) so that every
// spelling of one device shares a single counter.
export async function reserveDeviceAttempt(mac: string): Promise<void> {
  if ((await activeHits(deviceLockStore, mac)) > 0) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: DEVICE_LOCKED_MESSAGE,
    });
  }
  const attempts = (await deviceAttemptStore.increment(mac)).totalHits;
  if (attempts > DEVICE_PIN_MAX_FAILURES) {
    // Starts a 15-minute lock from now. Both stores only open a new window
    // when none is active, so concurrent refusals never extend the lock.
    await deviceLockStore.increment(mac);
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: DEVICE_LOCKED_MESSAGE,
    });
  }
}

// Only one slot is given back: resetKey would also erase the slots of
// attempts still in flight and reopen the race.
export async function refundDeviceAttempt(mac: string): Promise<void> {
  await deviceAttemptStore.decrement(mac);
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

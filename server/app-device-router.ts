import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { appClients, playlists } from "@db/schema";
import type { AppClient } from "@db/schema";
import { decryptSecret, hashSecret, verifySecret } from "./lib/crypto";
import {
  claimCodeSchema,
  computeTrialEndsAt,
  isCinekinPlayerDeviceId,
  licenseStatus,
  macAddressSchema,
  macLookupVariants,
} from "./lib/app-license";
import {
  assertDeviceNotLocked,
  assertNewDeviceQuota,
  clearDevicePinFailures,
  recordDevicePinFailure,
  recordNewDevice,
} from "./lib/device-limits";
import { isDuplicateKeyError } from "./lib/db-errors";

const pinSchema = z
  .string()
  .regex(/^\d{6}$/, "Le PIN doit contenir exactement 6 chiffres.");

// One generic message for unknown MAC, wrong PIN and untrusted row, so the
// device API never reveals whether a MAC exists.
export const DEVICE_CREDENTIALS_ERROR = "MAC ou PIN incorrect.";

const deviceCredentialsSchema = z.object({
  mac: macAddressSchema,
  pin: pinSchema,
});

const deviceStatusValueSchema = z.enum([
  "trial",
  "active",
  "expired",
  "inactive",
]);

// Loose objects: fields will be added later (e.g. an expiry reason in 2B).
// The app must ignore fields it does not know.
export const deviceStatusOutputSchema = z.looseObject({
  status: deviceStatusValueSchema,
  licenseType: z.enum(["12_months", "unlimited"]).nullable(),
  expiresAt: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  serverTime: z.string(),
});

export const devicePlaylistsOutputSchema = z.looseObject({
  status: deviceStatusValueSchema,
  serverTime: z.string(),
  playlists: z.array(
    z.looseObject({
      id: z.number(),
      name: z.string(),
      format: z.enum(["m3u", "xtream"]),
      source: z.enum(["cinekin", "external"]),
      m3uUrl: z.string().nullable(),
      xtreamServerUrl: z.string().nullable(),
      xtreamUsername: z.string().nullable(),
      xtreamPassword: z.string().nullable(),
    })
  ),
});

// ISO 8601 strings instead of Date objects: superjson would otherwise wrap
// dates with type metadata that the native app would have to understand.
function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

// verifySecret returns immediately when there is no stored hash. Hashing
// against a dummy value for unknown MACs keeps the response time close to a
// real check, so timing does not reveal which MACs exist.
let dummyPinHash: string | undefined;
function verifyPinConstantTime(
  pin: string,
  stored: string | null | undefined
): boolean {
  if (stored) return verifySecret(pin, stored);
  dummyPinHash ??= hashSecret("000000");
  verifySecret(pin, dummyPinHash);
  return false;
}

async function findClientByMac(mac: string): Promise<AppClient | undefined> {
  return (
    await getDb()
      .select()
      .from(appClients)
      .where(inArray(appClients.mac, macLookupVariants(mac)))
      .limit(1)
  ).at(0);
}

// MAC + PIN checked on every call (no cookie, no session). A row without
// claimedAt (legacy row, hardware MAC never verified) is refused.
async function authenticateDevice(
  mac: string,
  pin: string
): Promise<AppClient> {
  await assertDeviceNotLocked(mac);
  const client = await findClientByMac(mac);
  const pinMatches = verifyPinConstantTime(pin, client?.pinHash);
  if (!client || !client.claimedAt || !pinMatches) {
    // Unknown MACs count too: otherwise the lockout would reveal existence.
    await recordDevicePinFailure(mac);
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: DEVICE_CREDENTIALS_ERROR,
    });
  }
  await clearDevicePinFailures(mac);
  return client;
}

// tRPC sends query inputs in the URL (GET), so the PIN would end up in access
// logs: both device read operations are mutations (POST body) on purpose, and
// their responses must never be cached.
function preventCaching(resHeaders: Headers): void {
  resHeaders.set("Cache-Control", "no-store");
}

// PUBLIC entry points called by the client application (TV/box).
// Wire format and error codes: docs/app-device-api.md.
export const appDeviceRouter = createRouter({
  // Called on first launch.
  registerDevice: publicQuery
    .input(
      z.object({
        mac: macAddressSchema,
        pin: pinSchema,
        claimCode: claimCodeSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const mac = input.mac;
      let existing = await findClientByMac(mac);

      // New MAC → create the client.
      if (!existing) {
        await assertNewDeviceQuota(ctx.clientIp);

        // A CinéKin Player MAC (locally administered, derived from the
        // ANDROID_ID) cannot be known before the app's first launch, so its
        // self-registration is trusted and starts the free trial. Any other
        // MAC keeps the historical behaviour: untrusted until a reseller or
        // admin activation proves possession with a one-time code.
        const now = new Date();
        const trusted = isCinekinPlayerDeviceId(mac);
        const trialEndsAt = trusted ? computeTrialEndsAt(now) : null;
        try {
          await db.insert(appClients).values({
            mac,
            pinHash: hashSecret(input.pin),
            claimedAt: trusted ? now : null,
            trialStartedAt: trusted ? now : null,
            trialEndsAt,
          });
          await recordNewDevice(ctx.clientIp);
          return {
            registered: true,
            activated: false,
            alreadyKnown: false,
            verificationRequired: !trusted,
            status: trusted ? ("trial" as const) : ("inactive" as const),
            trialEndsAt: toIso(trialEndsAt),
          };
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
          // A concurrent registration won the unique-MAC insert. Reload that
          // row and apply the normal PIN/claim checks instead of returning 500.
          existing = await findClientByMac(mac);
          if (!existing) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Enregistrement concurrent détecté. Veuillez réessayer.",
            });
          }
        }
      }

      // Known MAC that was pre-activated (admin/reseller) but never registered:
      // possession must be proven with the one-time code displayed to the
      // activator. Knowing a MAC address alone is never sufficient.
      if (!existing.pinHash) {
        const claimExpired =
          !existing.claimCodeExpiresAt ||
          existing.claimCodeExpiresAt.getTime() <= Date.now();
        if (
          !input.claimCode ||
          !existing.claimCodeHash ||
          claimExpired ||
          !verifySecret(input.claimCode, existing.claimCodeHash)
        ) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Code d'activation invalide ou expiré.",
          });
        }

        const updateResult = await db
          .update(appClients)
          .set({
            pinHash: hashSecret(input.pin),
            claimCodeHash: null,
            claimCodeExpiresAt: null,
            claimedAt: new Date(),
          })
          .where(
            and(
              eq(appClients.id, existing.id),
              isNull(appClients.pinHash),
              eq(appClients.claimCodeHash, existing.claimCodeHash)
            )
          );
        const affectedRows =
          (updateResult as unknown as [{ affectedRows?: number }])[0]
            ?.affectedRows ?? 0;

        // A concurrent request may have claimed the device between the SELECT
        // and UPDATE. Never overwrite that winner's PIN.
        if (affectedRows < 1) {
          const current = (
            await db
              .select()
              .from(appClients)
              .where(eq(appClients.id, existing.id))
              .limit(1)
          ).at(0);
          if (!current?.pinHash || !verifySecret(input.pin, current.pinHash)) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "Cet appareil vient d'être enregistré avec un autre PIN.",
            });
          }
        }
        return {
          registered: true,
          activated: existing.licenseType != null,
          alreadyKnown: true,
          verificationRequired: false,
          status: licenseStatus(existing),
          trialEndsAt: toIso(existing.trialEndsAt),
        };
      }

      // Known MAC with a PIN → the PIN must match; nothing is mutated (the
      // trial is never restarted nor extended). The lock is checked first.
      await assertDeviceNotLocked(mac);
      if (!verifySecret(input.pin, existing.pinHash)) {
        await recordDevicePinFailure(mac);
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "PIN incorrect pour cette adresse MAC.",
        });
      }
      await clearDevicePinFailures(mac);

      // Idempotent: same MAC + correct PIN, no side effects.
      return {
        registered: true,
        activated: existing.licenseType != null,
        alreadyKnown: true,
        verificationRequired: existing.claimedAt == null,
        status: licenseStatus(existing),
        trialEndsAt: toIso(existing.trialEndsAt),
      };
    }),

  // Called on every launch.
  deviceStatus: publicQuery
    .input(deviceCredentialsSchema)
    .output(deviceStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      preventCaching(ctx.resHeaders);
      const client = await authenticateDevice(input.mac, input.pin);
      const now = new Date();
      return {
        status: licenseStatus(client, now),
        licenseType: client.licenseType ?? null,
        expiresAt: toIso(client.expiresAt),
        trialEndsAt: toIso(client.trialEndsAt),
        serverTime: now.toISOString(),
      };
    }),

  // SECURITY: this is the ONLY route that returns Xtream passwords in clear
  // text. The device needs them to connect to the Xtream server; everywhere
  // else (client portal, admin) the password stays write-only. URLs and
  // credentials are returned only while the device is in trial or has an
  // active licence, and MAC + PIN are verified on every call.
  devicePlaylists: publicQuery
    .input(deviceCredentialsSchema)
    .output(devicePlaylistsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      preventCaching(ctx.resHeaders);
      const client = await authenticateDevice(input.mac, input.pin);
      const now = new Date();
      const status = licenseStatus(client, now);
      const serverTime = now.toISOString();

      if (status !== "trial" && status !== "active") {
        // Expired or inactive: no playlist, hence no URL nor credential.
        return { status, serverTime, playlists: [] };
      }

      const rows = await getDb()
        .select()
        .from(playlists)
        .where(eq(playlists.appClientId, client.id))
        .orderBy(desc(playlists.createdAt));

      return {
        status,
        serverTime,
        playlists: rows.map(p => {
          const xtream = p.format === "xtream";
          return {
            id: p.id,
            name: p.name,
            format: p.format,
            source: p.source,
            m3uUrl: xtream ? null : (p.m3uUrl ?? null),
            xtreamServerUrl: xtream ? decryptSecret(p.xtreamServerUrl) : null,
            xtreamUsername: xtream ? decryptSecret(p.xtreamUsername) : null,
            xtreamPassword: xtream ? decryptSecret(p.xtreamPassword) : null,
          };
        }),
      };
    }),
});

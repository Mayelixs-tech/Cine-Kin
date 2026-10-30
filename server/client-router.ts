import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createRouter, publicQuery, clientQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { appClients, playlists } from "@db/schema";
import { ClientSession } from "@contracts/constants";
import {
  hashSecret,
  verifySecret,
  encryptSecret,
  decryptSecret,
} from "./lib/crypto";
import {
  sessionVersionForCredential,
  signClientSession,
} from "./lib/app-sessions";
import { appendSessionCookie, clearSessionCookie } from "./lib/cookies";
import {
  macAddressSchema,
  macLookupVariants,
  licenseStatus,
} from "./lib/app-license";

const parentalPinSchema = z
  .string()
  .regex(/^\d{4}$/, "Le code parental doit faire 4 chiffres.");

const addPlaylistSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    format: z.enum(["m3u", "xtream"]),
    source: z.enum(["cinekin", "external"]),
    m3uUrl: z.string().url().max(2048).optional(),
    xtreamServerUrl: z.string().url().max(2048).optional(),
    xtreamUsername: z.string().min(1).max(255).optional(),
    xtreamPassword: z.string().min(1).max(255).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.format === "m3u") {
      if (!val.m3uUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["m3uUrl"],
          message: "URL M3U requise.",
        });
      }
    } else {
      if (!val.xtreamServerUrl || !val.xtreamUsername || !val.xtreamPassword) {
        ctx.addIssue({
          code: "custom",
          path: ["xtreamServerUrl"],
          message: "Serveur, identifiant et mot de passe Xtream requis.",
        });
      }
    }
  });

export const clientRouter = createRouter({
  // Client portal login (MAC + PIN) → sets the client session cookie.
  login: publicQuery
    .input(
      z.object({
        mac: macAddressSchema,
        pin: z
          .string()
          .regex(/^\d{6}$/, "Le PIN doit contenir exactement 6 chiffres."),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const mac = input.mac;
      const client = (
        await getDb()
          .select()
          .from(appClients)
          .where(inArray(appClients.mac, macLookupVariants(mac)))
          .limit(1)
      ).at(0);

      if (!client?.claimedAt || !verifySecret(input.pin, client.pinHash)) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "MAC ou PIN incorrect.",
        });
      }

      const token = await signClientSession(
        client.id,
        sessionVersionForCredential(client.pinHash ?? "")
      );
      appendSessionCookie(
        ctx.resHeaders,
        ctx.req.headers,
        ClientSession.cookieName,
        token,
        ClientSession.maxAgeMs
      );
      return { success: true };
    }),

  logout: clientQuery.mutation(({ ctx }) => {
    clearSessionCookie(
      ctx.resHeaders,
      ctx.req.headers,
      ClientSession.cookieName
    );
    return { success: true };
  }),

  getDashboard: clientQuery.query(async ({ ctx }) => {
    const client = ctx.appClient;
    const playlistRows = await getDb()
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.appClientId, client.id));

    return {
      mac: client.mac,
      name: client.name,
      email: client.email,
      licenseType: client.licenseType,
      status: licenseStatus(client),
      activatedAt: client.activatedAt,
      expiresAt: client.expiresAt,
      trialEndsAt: client.trialEndsAt,
      parentalControlEnabled: client.parentalControlPinHash != null,
      playlistCount: playlistRows.length,
    };
  }),

  listPlaylists: clientQuery.query(async ({ ctx }) => {
    const rows = await getDb()
      .select()
      .from(playlists)
      .where(eq(playlists.appClientId, ctx.appClient.id))
      .orderBy(desc(playlists.createdAt));

    // Decrypt server URL + username for the owner's own view; the Xtream
    // password stays write-only (never returned).
    return rows.map(p => ({
      id: p.id,
      name: p.name,
      format: p.format,
      source: p.source,
      m3uUrl: p.m3uUrl,
      xtreamServerUrl: decryptSecret(p.xtreamServerUrl),
      xtreamUsername: decryptSecret(p.xtreamUsername),
      xtreamHasPassword: p.xtreamPassword != null,
      createdAt: p.createdAt,
    }));
  }),

  addPlaylist: clientQuery
    .input(addPlaylistSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await getDb()
        .insert(playlists)
        .values({
          appClientId: ctx.appClient.id,
          name: input.name,
          format: input.format,
          source: input.source,
          m3uUrl: input.format === "m3u" ? (input.m3uUrl ?? null) : null,
          xtreamServerUrl:
            input.format === "xtream" && input.xtreamServerUrl
              ? encryptSecret(input.xtreamServerUrl)
              : null,
          xtreamUsername:
            input.format === "xtream" && input.xtreamUsername
              ? encryptSecret(input.xtreamUsername)
              : null,
          xtreamPassword:
            input.format === "xtream" && input.xtreamPassword
              ? encryptSecret(input.xtreamPassword)
              : null,
        })
        .$returningId();
      return { id: result[0].id };
    }),

  // Deletion is never blocked server-side — even for the bundled Ciné-Kin
  // playlist. The frontend shows a more explicit confirmation for that case.
  deletePlaylist: clientQuery
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await getDb()
        .delete(playlists)
        .where(
          and(
            eq(playlists.id, input.id),
            eq(playlists.appClientId, ctx.appClient.id)
          )
        );
      return { success: true };
    }),

  getParentalControl: clientQuery.query(({ ctx }) => {
    return { enabled: ctx.appClient.parentalControlPinHash != null };
  }),

  updateParentalControl: clientQuery
    .input(
      z.object({
        // Empty when setting the code for the first time.
        currentCode: z.string().optional(),
        newCode: parentalPinSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const current = ctx.appClient.parentalControlPinHash;
      if (current) {
        if (!input.currentCode || !verifySecret(input.currentCode, current)) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Code parental actuel incorrect.",
          });
        }
      }
      await getDb()
        .update(appClients)
        .set({ parentalControlPinHash: hashSecret(input.newCode) })
        .where(eq(appClients.id, ctx.appClient.id));
      return { success: true };
    }),
});

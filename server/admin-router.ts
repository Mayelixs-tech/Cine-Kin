import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  orders,
  customers,
  appClients,
  resellers,
  activations,
  resellerCreditLedger,
} from "@db/schema";
import type { Reseller } from "@db/schema";
import { eq, desc, count, inArray, sql } from "drizzle-orm";
import { hashSecret } from "./lib/crypto";
import {
  licenseTypeSchema,
  computeExpiry,
  computeRenewalExpiry,
  macAddressSchema,
  macLookupVariants,
  autoEmail,
  licenseStatus,
} from "./lib/app-license";
import { createClaimCredential } from "./lib/claim-code";
import { isDuplicateKeyError } from "./lib/db-errors";

// Public reseller shape for admin responses — never leaks passwordHash.
function resellerAdminView(r: Reseller) {
  return {
    id: r.id,
    name: r.name,
    contact: r.contact,
    username: r.username,
    credits: r.credits,
    createdAt: r.createdAt,
  };
}

// Generate a random activation code: CINE + 6 alphanumeric chars
function generateActivationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "CINE";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export const adminRouter = createRouter({
  // Orders
  orderList: adminQuery.query(async () => {
    return getDb().query.orders.findMany({
      orderBy: [desc(orders.createdAt)],
    });
  }),

  orderCreate: adminQuery
    .input(
      z.object({
        customerName: z.string().min(1),
        customerEmail: z.string().email(),
        customerPhone: z.string().min(1),
        planId: z.string(),
        planName: z.string(),
        planType: z.enum(["client", "reseller"]),
        price: z.string(),
        device: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const activationCode = generateActivationCode();
      const result = await getDb()
        .insert(orders)
        .values({
          ...input,
          device: input.device || null,
          status: "pending",
          activationCode,
        })
        .$returningId();
      return { id: result[0].id, activationCode };
    }),

  orderUpdateStatus: adminQuery
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["pending", "active", "expired", "cancelled"]),
      })
    )
    .mutation(async ({ input }) => {
      await getDb()
        .update(orders)
        .set({ status: input.status })
        .where(eq(orders.id, input.id));
      return { success: true };
    }),

  orderDelete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await getDb().delete(orders).where(eq(orders.id, input.id));
      return { success: true };
    }),

  orderStats: adminQuery.query(async () => {
    const db = getDb();
    const allOrders = await db.select({ count: count() }).from(orders);
    const pendingOrders = await db
      .select({ count: count() })
      .from(orders)
      .where(eq(orders.status, "pending"));
    const activeOrders = await db
      .select({ count: count() })
      .from(orders)
      .where(eq(orders.status, "active"));
    return {
      total: allOrders[0].count,
      pending: pendingOrders[0].count,
      active: activeOrders[0].count,
    };
  }),

  // Customers
  customerList: adminQuery.query(async () => {
    return getDb().query.customers.findMany({
      orderBy: [desc(customers.createdAt)],
    });
  }),

  customerCreate: adminQuery
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        phone: z.string().min(1),
        device: z.string().optional(),
        planId: z.string(),
        planName: z.string(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const result = await getDb()
        .insert(customers)
        .values({
          ...input,
          device: input.device || null,
          notes: input.notes || null,
          status: "active",
        })
        .$returningId();
      return result[0];
    }),

  customerUpdateStatus: adminQuery
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["active", "expired", "suspended"]),
      })
    )
    .mutation(async ({ input }) => {
      await getDb()
        .update(customers)
        .set({ status: input.status })
        .where(eq(customers.id, input.id));
      return { success: true };
    }),

  customerDelete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      await getDb().delete(customers).where(eq(customers.id, input.id));
      return { success: true };
    }),

  customerStats: adminQuery.query(async () => {
    const db = getDb();
    const allCustomers = await db.select({ count: count() }).from(customers);
    const activeCustomers = await db
      .select({ count: count() })
      .from(customers)
      .where(eq(customers.status, "active"));
    return {
      total: allCustomers[0].count,
      active: activeCustomers[0].count,
    };
  }),

  // -------------------------------------------------------------------------
  // Application licence — admin procedures (free, no credit deduction).
  // -------------------------------------------------------------------------

  appClientList: adminQuery.query(async () => {
    // Explicit public projection: hashes and future secret columns must never
    // leave the server simply because they were added to the DB row type.
    const rows = await getDb()
      .select({
        id: appClients.id,
        mac: appClients.mac,
        name: appClients.name,
        email: appClients.email,
        licenseType: appClients.licenseType,
        activatedByType: appClients.activatedByType,
        activatedByResellerId: appClients.activatedByResellerId,
        activatedAt: appClients.activatedAt,
        expiresAt: appClients.expiresAt,
        trialEndsAt: appClients.trialEndsAt,
        createdAt: appClients.createdAt,
        pinHash: appClients.pinHash,
        claimedAt: appClients.claimedAt,
        claimCodeExpiresAt: appClients.claimCodeExpiresAt,
      })
      .from(appClients)
      .orderBy(desc(appClients.createdAt));
    return rows.map(({ pinHash, ...row }) => ({
      ...row,
      isRegistered: pinHash != null && row.claimedAt != null,
      claimCodePending:
        row.claimedAt == null &&
        row.claimCodeExpiresAt != null &&
        row.claimCodeExpiresAt.getTime() > Date.now(),
    }));
  }),

  appClientActivate: adminQuery
    .input(
      z.object({
        mac: macAddressSchema,
        name: z.string().trim().min(1).max(255).optional(),
        email: z.string().email().optional(),
        licenseType: licenseTypeSchema,
      })
    )
    .mutation(async ({ input }) => {
      const mac = input.mac;
      const now = new Date();
      const expiresAt = computeExpiry(input.licenseType, now);
      const email = input.email?.trim() || autoEmail(input.name, mac);

      const outcome = await getDb()
        .transaction(async tx => {
          const existing = (
            await tx
              .select()
              .from(appClients)
              .where(inArray(appClients.mac, macLookupVariants(mac)))
              .limit(1)
              .for("update")
          ).at(0);

          if (existing && licenseStatus(existing) === "active") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Cette MAC a déjà une licence active. Utilisez appClientRenew pour la renouveler.",
            });
          }

          const claim = existing?.claimedAt ? null : createClaimCredential(now);
          let appClientId: number;
          if (!existing) {
            const ins = await tx
              .insert(appClients)
              .values({
                mac,
                name: input.name ?? null,
                email,
                licenseType: input.licenseType,
                activatedByType: "admin",
                activatedAt: now,
                expiresAt,
                claimCodeHash: claim?.claimCodeHash ?? null,
                claimCodeExpiresAt: claim?.claimCodeExpiresAt ?? null,
              })
              .$returningId();
            appClientId = ins[0].id;
          } else {
            appClientId = existing.id;
            await tx
              .update(appClients)
              .set({
                name: input.name ?? existing.name,
                email: existing.email ?? email,
                licenseType: input.licenseType,
                activatedByType: "admin",
                activatedByResellerId: null,
                activatedAt: now,
                expiresAt,
                ...(claim
                  ? {
                      pinHash: null,
                      claimedAt: null,
                      claimCodeHash: claim.claimCodeHash,
                      claimCodeExpiresAt: claim.claimCodeExpiresAt,
                    }
                  : {}),
              })
              .where(eq(appClients.id, existing.id));
          }

          await tx.insert(activations).values({
            appClientId,
            mac,
            licenseType: input.licenseType,
            creditsCharged: 0,
            activatedByType: "admin",
          });

          return { appClientId, claim };
        })
        .catch((error: unknown) => {
          if (isDuplicateKeyError(error)) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "Une fiche existe déjà avec cette MAC ou cette adresse e-mail.",
            });
          }
          throw error;
        });

      return {
        success: true,
        appClientId: outcome.appClientId,
        licenseType: input.licenseType,
        claimCode: outcome.claim?.claimCode ?? null,
        claimCodeExpiresAt: outcome.claim?.claimCodeExpiresAt ?? null,
      };
    }),

  appClientRenew: adminQuery
    .input(
      z.object({
        appClientId: z.number().int().positive(),
        licenseType: licenseTypeSchema,
      })
    )
    .mutation(async ({ input }) => {
      const now = new Date();
      const outcome = await getDb().transaction(async tx => {
        const client = (
          await tx
            .select()
            .from(appClients)
            .where(eq(appClients.id, input.appClientId))
            .limit(1)
            .for("update")
        ).at(0);
        if (!client) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Client introuvable.",
          });
        }
        if (
          client.licenseType === "unlimited" &&
          licenseStatus(client) === "active"
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cette licence est déjà illimitée et ne doit pas être renouvelée.",
          });
        }

        const expiresAt = computeRenewalExpiry(
          input.licenseType,
          now,
          client.expiresAt
        );
        const claim = client.claimedAt ? null : createClaimCredential(now);
        await tx
          .update(appClients)
          .set({
            licenseType: input.licenseType,
            activatedByType: "admin",
            activatedByResellerId: null,
            activatedAt: now,
            expiresAt,
            ...(claim
              ? {
                  pinHash: null,
                  claimedAt: null,
                  claimCodeHash: claim.claimCodeHash,
                  claimCodeExpiresAt: claim.claimCodeExpiresAt,
                }
              : {}),
          })
          .where(eq(appClients.id, client.id));

        await tx.insert(activations).values({
          appClientId: client.id,
          mac: client.mac,
          licenseType: input.licenseType,
          creditsCharged: 0,
          activatedByType: "admin",
        });

        return { client, claim, expiresAt };
      });

      return {
        success: true,
        appClientId: outcome.client.id,
        licenseType: input.licenseType,
        expiresAt: outcome.expiresAt,
        claimCode: outcome.claim?.claimCode ?? null,
        claimCodeExpiresAt: outcome.claim?.claimCodeExpiresAt ?? null,
      };
    }),

  appClientIssueClaimCode: adminQuery
    .input(z.object({ appClientId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const now = new Date();
      const claim = createClaimCredential(now);
      await getDb().transaction(async tx => {
        const client = (
          await tx
            .select()
            .from(appClients)
            .where(eq(appClients.id, input.appClientId))
            .limit(1)
            .for("update")
        ).at(0);
        if (!client) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Client introuvable.",
          });
        }
        if (client.pinHash && client.claimedAt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cet appareil est déjà enregistré avec son PIN.",
          });
        }
        await tx
          .update(appClients)
          .set({
            pinHash: null,
            claimedAt: null,
            claimCodeHash: claim.claimCodeHash,
            claimCodeExpiresAt: claim.claimCodeExpiresAt,
          })
          .where(eq(appClients.id, client.id));
      });
      return {
        appClientId: input.appClientId,
        claimCode: claim.claimCode,
        claimCodeExpiresAt: claim.claimCodeExpiresAt,
      };
    }),

  // Resellers ---------------------------------------------------------------

  resellerList: adminQuery.query(async () => {
    const rows = await getDb()
      .select()
      .from(resellers)
      .orderBy(desc(resellers.createdAt));
    return rows.map(resellerAdminView);
  }),

  resellerCreate: adminQuery
    .input(
      z.object({
        name: z.string().trim().min(1).max(255),
        contact: z.string().trim().max(255).optional(),
        username: z.string().trim().min(3).max(100),
        password: z.string().min(8).max(255),
        initialCredits: z.number().int().min(0).default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const resellerId = await getDb()
        .transaction(async tx => {
          const result = await tx
            .insert(resellers)
            .values({
              name: input.name,
              contact: input.contact ?? null,
              username: input.username,
              passwordHash: hashSecret(input.password),
              credits: input.initialCredits,
            })
            .$returningId();
          const id = result[0].id;
          await tx.insert(resellerCreditLedger).values({
            resellerId: id,
            delta: input.initialCredits,
            balanceAfter: input.initialCredits,
            entryType: "initial_grant",
            actorType: "admin",
            actorUserId: ctx.user.id,
            reason: "Solde initial à la création du revendeur",
          });
          return id;
        })
        .catch((error: unknown) => {
          if (isDuplicateKeyError(error)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Cet identifiant revendeur est déjà utilisé.",
            });
          }
          throw error;
        });
      return { id: resellerId, username: input.username };
    }),

  resellerAddCredits: adminQuery
    .input(
      z.object({
        resellerId: z.number().int().positive(),
        amount: z.number().int().positive(),
        reason: z.string().trim().min(3).max(255),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const credits = await getDb().transaction(async tx => {
        const updateResult = await tx
          .update(resellers)
          .set({ credits: sql`${resellers.credits} + ${input.amount}` })
          .where(eq(resellers.id, input.resellerId));
        const affected =
          (updateResult as unknown as [{ affectedRows?: number }])[0]
            ?.affectedRows ?? 0;
        if (affected < 1) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Revendeur introuvable.",
          });
        }

        const updated = (
          await tx
            .select({ credits: resellers.credits })
            .from(resellers)
            .where(eq(resellers.id, input.resellerId))
            .limit(1)
        ).at(0);
        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Revendeur introuvable.",
          });
        }

        await tx.insert(resellerCreditLedger).values({
          resellerId: input.resellerId,
          delta: input.amount,
          balanceAfter: updated.credits,
          entryType: "admin_grant",
          actorType: "admin",
          actorUserId: ctx.user.id,
          reason: input.reason,
        });
        return updated.credits;
      });
      return { success: true, credits };
    }),

  resellerCreditHistory: adminQuery
    .input(
      z.object({
        resellerId: z.number().int().positive(),
        limit: z.number().int().min(1).max(500).default(200),
      })
    )
    .query(async ({ input }) => {
      return getDb()
        .select()
        .from(resellerCreditLedger)
        .where(eq(resellerCreditLedger.resellerId, input.resellerId))
        .orderBy(desc(resellerCreditLedger.createdAt))
        .limit(input.limit);
    }),

  resellerActivationHistory: adminQuery
    .input(z.object({ resellerId: z.number().int().positive() }))
    .query(async ({ input }) => {
      return getDb()
        .select()
        .from(activations)
        .where(eq(activations.activatedByResellerId, input.resellerId))
        .orderBy(desc(activations.createdAt));
    }),

  // Global feed of recent activations (admin + reseller), most recent first.
  activationList: adminQuery
    .input(
      z
        .object({ limit: z.number().int().min(1).max(500).default(100) })
        .optional()
    )
    .query(async ({ input }) => {
      return getDb()
        .select()
        .from(activations)
        .orderBy(desc(activations.createdAt))
        .limit(input?.limit ?? 100);
    }),
});

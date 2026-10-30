import { describe, it, expect, vi } from "vitest";
import { appRouter } from "./router";
import { createCallerFactory } from "./middleware";
import type { TrpcContext } from "./context";
import type { User, AppClient, Reseller } from "@db/schema";

// Stub the DB layer. The authorization tests below reject inside the auth
// middleware, before any resolver (and therefore any DB call) runs, so this is
// only a safety net.
vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  }),
}));

const createCaller = createCallerFactory(appRouter);
type Caller = ReturnType<typeof createCaller>;

function makeCtx(over?: Partial<TrpcContext>): TrpcContext {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    ...over,
  };
}

const adminUser: User = {
  id: 1,
  unionId: "union-admin",
  name: "Admin",
  email: null,
  avatar: null,
  role: "admin",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignInAt: new Date(),
};

const normalUser: User = {
  ...adminUser,
  id: 2,
  unionId: "union-user",
  role: "user",
};

const sampleReseller: Reseller = {
  id: 10,
  name: "Reseller One",
  contact: "wa:+243...",
  username: "reseller1",
  passwordHash: "scrypt$deadbeef$cafe",
  credits: 42,
  createdAt: new Date(),
};

const sampleAppClient: AppClient = {
  id: 100,
  mac: "00:11:22:33:44:55",
  pinHash: "scrypt$deadbeef$cafe",
  claimCodeHash: null,
  claimCodeExpiresAt: null,
  claimedAt: new Date(),
  name: "Device",
  email: "device@client.cine-kin.tv",
  licenseType: "12_months",
  activatedByType: "reseller",
  activatedByResellerId: 10,
  activatedAt: new Date(),
  expiresAt: new Date(Date.now() + 1_000_000),
  parentalControlPinHash: null,
  trialStartedAt: null,
  trialEndsAt: null,
  createdAt: new Date(),
};

// --- Procedure descriptors (valid inputs; auth rejects before validation). ---

const RESELLER_PROCEDURES: {
  name: string;
  call: (c: Caller) => Promise<unknown>;
}[] = [
  { name: "me", call: c => c.reseller.me() },
  {
    name: "activate",
    call: c =>
      c.reseller.activate({
        mac: "00:11:22:33:44:55",
        licenseType: "12_months",
      }),
  },
  {
    name: "issueClaimCode",
    call: c => c.reseller.issueClaimCode({ appClientId: 1 }),
  },
  { name: "myActivations", call: c => c.reseller.myActivations() },
  { name: "creditHistory", call: c => c.reseller.creditHistory() },
  {
    name: "changePassword",
    call: c =>
      c.reseller.changePassword({
        currentPassword: "old",
        newPassword: "newpass12",
      }),
  },
];

const ADMIN_APP_PROCEDURES: {
  name: string;
  call: (c: Caller) => Promise<unknown>;
}[] = [
  { name: "appClientList", call: c => c.admin.appClientList() },
  {
    name: "appClientActivate",
    call: c =>
      c.admin.appClientActivate({
        mac: "00:11:22:33:44:55",
        licenseType: "12_months",
      }),
  },
  {
    name: "appClientRenew",
    call: c =>
      c.admin.appClientRenew({ appClientId: 1, licenseType: "unlimited" }),
  },
  {
    name: "appClientIssueClaimCode",
    call: c => c.admin.appClientIssueClaimCode({ appClientId: 1 }),
  },
  { name: "resellerList", call: c => c.admin.resellerList() },
  {
    name: "resellerCreate",
    call: c =>
      c.admin.resellerCreate({
        name: "R",
        username: "reseller9",
        password: "password12",
        initialCredits: 5,
      }),
  },
  {
    name: "resellerAddCredits",
    call: c =>
      c.admin.resellerAddCredits({
        resellerId: 1,
        amount: 10,
        reason: "Recharge test",
      }),
  },
  {
    name: "resellerActivationHistory",
    call: c => c.admin.resellerActivationHistory({ resellerId: 1 }),
  },
  {
    name: "resellerCreditHistory",
    call: c => c.admin.resellerCreditHistory({ resellerId: 1, limit: 20 }),
  },
];

const CLIENT_PROCEDURES: {
  name: string;
  call: (c: Caller) => Promise<unknown>;
}[] = [
  { name: "getDashboard", call: c => c.clientPortal.getDashboard() },
  { name: "listPlaylists", call: c => c.clientPortal.listPlaylists() },
  {
    name: "addPlaylist",
    call: c =>
      c.clientPortal.addPlaylist({
        name: "P",
        format: "m3u",
        source: "external",
        m3uUrl: "https://example.tv/p.m3u",
      }),
  },
  {
    name: "deletePlaylist",
    call: c => c.clientPortal.deletePlaylist({ id: 1 }),
  },
  {
    name: "getParentalControl",
    call: c => c.clientPortal.getParentalControl(),
  },
  {
    name: "updateParentalControl",
    call: c => c.clientPortal.updateParentalControl({ newCode: "1234" }),
  },
];

// --- Reseller procedures --------------------------------------------------

describe("reseller router — anonymous caller (no session) is rejected", () => {
  it.each(RESELLER_PROCEDURES)("$name → UNAUTHORIZED", async ({ call }) => {
    const caller = createCaller(makeCtx());
    await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("reseller router — a non-reseller session (admin user) is rejected", () => {
  it.each(RESELLER_PROCEDURES)("$name → UNAUTHORIZED", async ({ call }) => {
    const caller = createCaller(makeCtx({ user: adminUser }));
    await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("reseller router — a valid reseller session passes the guard", () => {
  it("me resolves and never leaks the password hash", async () => {
    const caller = createCaller(makeCtx({ reseller: sampleReseller }));
    const profile = await caller.reseller.me();
    expect(profile).toMatchObject({
      id: 10,
      username: "reseller1",
      credits: 42,
    });
    expect(profile).not.toHaveProperty("passwordHash");
  });
});

// --- Admin application-licence procedures ---------------------------------

describe("admin app-licence router — anonymous caller is rejected", () => {
  it.each(ADMIN_APP_PROCEDURES)("$name → UNAUTHORIZED", async ({ call }) => {
    const caller = createCaller(makeCtx());
    await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("admin app-licence router — authenticated non-admin is rejected", () => {
  it.each(ADMIN_APP_PROCEDURES)("$name → FORBIDDEN", async ({ call }) => {
    const caller = createCaller(makeCtx({ user: normalUser }));
    await expect(call(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("admin app-licence router — a reseller session cannot call admin procedures", () => {
  it.each(ADMIN_APP_PROCEDURES)("$name → UNAUTHORIZED", async ({ call }) => {
    const caller = createCaller(makeCtx({ reseller: sampleReseller }));
    await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// --- Client procedures ----------------------------------------------------

describe("client router — anonymous caller is rejected", () => {
  it.each(CLIENT_PROCEDURES)("$name → UNAUTHORIZED", async ({ call }) => {
    const caller = createCaller(makeCtx());
    await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("client router — a reseller session cannot call client procedures", () => {
  it.each(CLIENT_PROCEDURES)("$name → UNAUTHORIZED", async ({ call }) => {
    const caller = createCaller(makeCtx({ reseller: sampleReseller }));
    await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("client router — a valid client session passes the guard", () => {
  it("getParentalControl resolves from the session context", async () => {
    const caller = createCaller(makeCtx({ appClient: sampleAppClient }));
    await expect(caller.clientPortal.getParentalControl()).resolves.toEqual({
      enabled: false,
    });
  });
});

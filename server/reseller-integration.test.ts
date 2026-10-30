/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Integration harness: a small stateful in-memory fake for getDb(). Only the
// drizzle query *helpers* (eq/and/gte/sql/desc) are mocked so the fake can
// interpret conditions; the schema (real mysqlTable columns) and the crypto
// (real scrypt) are untouched, so these tests exercise the actual resolver
// logic — credit deduction, hashing, per-reseller filtering, password change.
// ---------------------------------------------------------------------------

const shared = vi.hoisted(() => {
  // A real HS256 secret so reseller.login can sign a session on success.
  process.env.APP_SECRET = "test-app-secret-0123456789-abcdefghij";
  return {
    store: {
      resellers: [] as any[],
      activations: [] as any[],
      appClients: [] as any[],
      playlists: [] as any[],
      creditLedger: [] as any[],
    },
    seq: { v: 0 },
  };
});

vi.mock("drizzle-orm", async importOriginal => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __c: "eq", col, val }),
    inArray: (col: unknown, vals: unknown[]) => ({ __c: "inArray", col, vals }),
    isNull: (col: unknown) => ({ __c: "isNull", col }),
    gte: (col: unknown, val: unknown) => ({ __c: "gte", col, val }),
    and: (...conds: unknown[]) => ({ __c: "and", conds }),
    desc: (col: unknown) => ({ __c: "desc", col }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      __c: "sql",
      values,
      expression: strings.join("?"),
    }),
  };
});

vi.mock("./queries/connection", async () => {
  const { getTableName } = await import("drizzle-orm");
  const store = shared.store;
  const seq = shared.seq;

  const arrFor = (t: any): any[] => {
    switch (getTableName(t)) {
      case "resellers":
        return store.resellers;
      case "activations":
        return store.activations;
      case "app_clients":
        return store.appClients;
      case "playlists":
        return store.playlists;
      case "reseller_credit_ledger":
        return store.creditLedger;
      default:
        throw new Error("unknown table: " + getTableName(t));
    }
  };
  const keyOf = (t: any, col: unknown): string =>
    Object.keys(t).find(k => t[k] === col) as string;
  const matches = (t: any, row: any, cond: any): boolean => {
    if (!cond) return true;
    switch (cond.__c) {
      case "and":
        return cond.conds.every((c: any) => matches(t, row, c));
      case "eq":
        return row[keyOf(t, cond.col)] === cond.val;
      case "inArray":
        return cond.vals.includes(row[keyOf(t, cond.col)]);
      case "isNull":
        return row[keyOf(t, cond.col)] == null;
      case "gte":
        return row[keyOf(t, cond.col)] >= cond.val;
      default:
        return true;
    }
  };
  const applySet = (t: any, row: any, setObj: any) => {
    for (const [k, v] of Object.entries<any>(setObj)) {
      if (v && typeof v === "object" && v.__c === "sql") {
        const [col, amount] = v.values;
        const current = row[keyOf(t, col)];
        row[keyOf(t, col)] = v.expression.includes("+")
          ? current + amount
          : current - amount;
      } else {
        row[k] = v;
      }
    }
  };

  const makeSelect = (projection?: any) => {
    const st: any = { table: null, conds: [], limit: null };
    const b: any = {
      from(t: any) {
        st.table = t;
        return b;
      },
      where(c: any) {
        st.conds.push(c);
        return b;
      },
      leftJoin() {
        return b;
      },
      orderBy() {
        return b;
      },
      limit(n: number) {
        st.limit = n;
        return b;
      },
      for() {
        return b;
      },
      then(res: any, rej: any) {
        try {
          let rows = arrFor(st.table).filter(r =>
            st.conds.every((c: any) => matches(st.table, r, c))
          );
          if (st.limit != null) rows = rows.slice(0, st.limit);
          const out = rows.map(r => {
            if (!projection) return { ...r };
            const o: any = {};
            for (const [alias, col] of Object.entries(projection))
              o[alias] = r[keyOf(st.table, col)];
            return o;
          });
          return Promise.resolve(out).then(res, rej);
        } catch (e) {
          return Promise.reject(e).then(res, rej);
        }
      },
    };
    return b;
  };

  const makeUpdate = (t: any) => {
    const st: any = { table: t, set: null, conds: [] };
    const b: any = {
      set(o: any) {
        st.set = o;
        return b;
      },
      where(c: any) {
        st.conds.push(c);
        return b;
      },
      then(res: any, rej: any) {
        let affected = 0;
        for (const row of arrFor(st.table)) {
          if (st.conds.every((c: any) => matches(st.table, row, c))) {
            applySet(st.table, row, st.set);
            affected++;
          }
        }
        return Promise.resolve([{ affectedRows: affected }]).then(res, rej);
      },
    };
    return b;
  };

  const makeInsert = (t: any) => {
    const st: any = { table: t, values: null };
    const doInsert = () => {
      const id = ++seq.v;
      arrFor(st.table).push({ id, ...st.values });
      return [{ id }];
    };
    const b: any = {
      values(v: any) {
        st.values = v;
        return b;
      },
      $returningId() {
        return Promise.resolve(doInsert());
      },
      then(res: any, rej: any) {
        return Promise.resolve(doInsert()).then(res, rej);
      },
    };
    return b;
  };

  const api: any = {
    select: (projection?: any) => makeSelect(projection),
    update: (t: any) => makeUpdate(t),
    insert: (t: any) => makeInsert(t),
    async transaction(cb: any) {
      const snap = structuredClone(store);
      try {
        return await cb(api);
      } catch (e) {
        store.resellers = snap.resellers;
        store.activations = snap.activations;
        store.appClients = snap.appClients;
        store.playlists = snap.playlists;
        store.creditLedger = snap.creditLedger;
        throw e;
      }
    },
  };

  return { getDb: () => api };
});

// Real modules (schema + crypto are NOT mocked).
import { appRouter } from "./router";
import { createCallerFactory } from "./middleware";
import { encryptSecret, hashSecret, verifySecret } from "./lib/crypto";
import {
  computeExpiry,
  normalizeClaimCode,
  TRIAL_DURATION_DAYS,
} from "./lib/app-license";
import {
  DEVICE_LOCKED_MESSAGE,
  DEVICE_PIN_MAX_FAILURES,
  NEW_DEVICES_PER_IP_LIMIT,
  newDevicesPerIpStore,
} from "./lib/device-limits";
import { DEVICE_CREDENTIALS_ERROR } from "./app-device-router";
import type { TrpcContext } from "./context";
import type { AppClient, User, Reseller } from "@db/schema";

const createCaller = createCallerFactory(appRouter);

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

function makeReseller(over: Partial<Reseller> = {}): Reseller {
  return {
    id: 1,
    name: "Reseller",
    contact: null,
    username: "reseller",
    passwordHash: hashSecret("password"),
    credits: 0,
    createdAt: new Date(),
    ...over,
  };
}

function makeAppClient(over: Partial<AppClient> = {}): AppClient {
  return {
    id: 100,
    mac: "aa:bb:cc:dd:ee:ff",
    pinHash: hashSecret("123456"),
    claimCodeHash: null,
    claimCodeExpiresAt: null,
    claimedAt: new Date(),
    name: "Salon",
    email: "salon@example.com",
    licenseType: "12_months",
    activatedByType: "reseller",
    activatedByResellerId: 1,
    activatedAt: new Date(),
    expiresAt: new Date(Date.now() + 1_000_000),
    parentalControlPinHash: null,
    trialStartedAt: null,
    trialEndsAt: null,
    createdAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  shared.store.resellers = [];
  shared.store.activations = [];
  shared.store.appClients = [];
  shared.store.playlists = [];
  shared.store.creditLedger = [];
  shared.seq.v = 0;
});

// 1. Credit guard ----------------------------------------------------------

describe("reseller.activate — credit guard", () => {
  it("refuses when the cost exceeds the balance and leaves the balance untouched", async () => {
    const reseller = makeReseller({ id: 1, credits: 1 }); // 1 credit
    shared.store.resellers.push(reseller);
    const caller = createCaller(makeCtx({ reseller }));

    // 'unlimited' costs 2 credits > balance of 1.
    await expect(
      caller.reseller.activate({
        mac: "aa:bb:cc:dd:ee:ff",
        licenseType: "unlimited",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Nothing was deducted and no side effects were committed (rolled back).
    expect(shared.store.resellers[0].credits).toBe(1);
    expect(shared.store.appClients).toHaveLength(0);
    expect(shared.store.activations).toHaveLength(0);
    expect(shared.store.creditLedger).toHaveLength(0);
  });

  it("never drives the balance negative across repeated spends", async () => {
    const reseller = makeReseller({ id: 1, credits: 1 });
    shared.store.resellers.push(reseller);
    const caller = createCaller(makeCtx({ reseller }));

    // First 12-month activation succeeds and drains the single credit.
    await expect(
      caller.reseller.activate({
        mac: "aa:bb:cc:dd:ee:01",
        licenseType: "12_months",
      })
    ).resolves.toMatchObject({ remainingCredits: 0 });

    // Second is refused — the atomic guard prevents going negative.
    await expect(
      caller.reseller.activate({
        mac: "aa:bb:cc:dd:ee:02",
        licenseType: "12_months",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(shared.store.resellers[0].credits).toBe(0);
    expect(shared.store.creditLedger).toHaveLength(1);
    expect(shared.store.creditLedger[0]).toMatchObject({
      resellerId: 1,
      delta: -1,
      balanceAfter: 0,
      entryType: "activation",
    });
  });
});

describe("reseller.activate — renewal integrity", () => {
  it("extends from the existing expiry and records the debit in the same ledger", async () => {
    const reseller = makeReseller({ id: 1, credits: 3 });
    const existingExpiry = new Date("2027-01-15T12:00:00Z");
    shared.store.resellers.push(reseller);
    shared.store.appClients.push(
      makeAppClient({
        id: 10,
        mac: "aa:bb:cc:dd:ee:10",
        expiresAt: existingExpiry,
      })
    );

    const result = await createCaller(makeCtx({ reseller })).reseller.activate({
      mac: "AA-BB-CC-DD-EE-10",
      licenseType: "12_months",
    });

    expect(result.action).toBe("renewed");
    expect(result.remainingCredits).toBe(2);
    expect(result.expiresAt).toEqual(new Date("2028-01-15T12:00:00Z"));
    expect(shared.store.appClients[0].expiresAt).toEqual(
      new Date("2028-01-15T12:00:00Z")
    );
    expect(shared.store.creditLedger[0]).toMatchObject({
      delta: -1,
      balanceAfter: 2,
      entryType: "activation",
      activationId: expect.any(Number),
    });
  });

  it("does not charge an already-unlimited device", async () => {
    const reseller = makeReseller({ id: 1, credits: 5 });
    shared.store.resellers.push(reseller);
    shared.store.appClients.push(
      makeAppClient({
        mac: "aa:bb:cc:dd:ee:11",
        licenseType: "unlimited",
        expiresAt: null,
      })
    );

    await expect(
      createCaller(makeCtx({ reseller })).reseller.activate({
        mac: "aa:bb:cc:dd:ee:11",
        licenseType: "unlimited",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(shared.store.resellers[0].credits).toBe(5);
    expect(shared.store.creditLedger).toHaveLength(0);
  });

  it("prevents one reseller from taking over another reseller's licence", async () => {
    const reseller = makeReseller({ id: 20, username: "outsider", credits: 5 });
    shared.store.resellers.push(reseller);
    shared.store.appClients.push(
      makeAppClient({
        id: 12,
        mac: "aa:bb:cc:dd:ee:12",
        activatedByResellerId: 10,
        expiresAt: new Date("2026-01-01T00:00:00Z"),
      })
    );

    await expect(
      createCaller(makeCtx({ reseller })).reseller.activate({
        mac: "aa:bb:cc:dd:ee:12",
        licenseType: "12_months",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(shared.store.resellers[0].credits).toBe(5);
    expect(shared.store.appClients[0].activatedByResellerId).toBe(10);
    expect(shared.store.creditLedger).toHaveLength(0);
  });
});

describe("device claim — proof of possession", () => {
  it("stores only a claim-code hash and consumes the code atomically", async () => {
    const reseller = makeReseller({ id: 1, credits: 2 });
    shared.store.resellers.push(reseller);
    const caller = createCaller(makeCtx({ reseller }));

    const activation = await caller.reseller.activate({
      mac: "aa:bb:cc:dd:ee:22",
      licenseType: "12_months",
    });
    expect(activation.claimCode).toMatch(
      /^CK-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/
    );

    const stored = shared.store.appClients[0];
    expect(stored.pinHash).toBeUndefined();
    expect(stored.claimCodeHash).not.toBe(activation.claimCode);
    expect(
      verifySecret(
        normalizeClaimCode(activation.claimCode!),
        stored.claimCodeHash
      )
    ).toBe(true);

    const anonymous = createCaller(makeCtx());
    await expect(
      anonymous.app.registerDevice({
        mac: "aa:bb:cc:dd:ee:22",
        pin: "654321",
        claimCode: "CK-AAAAA-AAAAA",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(stored.pinHash).toBeUndefined();

    await expect(
      anonymous.app.registerDevice({
        mac: "aa:bb:cc:dd:ee:22",
        pin: "654321",
        claimCode: activation.claimCode!,
      })
    ).resolves.toMatchObject({
      registered: true,
      activated: true,
      alreadyKnown: true,
    });

    expect(verifySecret("654321", stored.pinHash)).toBe(true);
    expect(stored.claimCodeHash).toBeNull();
    expect(stored.claimCodeExpiresAt).toBeNull();
    expect(stored.claimedAt).toBeInstanceOf(Date);
  });

  it("neutralises a PIN planted before the legitimate activation", async () => {
    // Hardware (globally administered) MAC: its self-registration is never
    // trusted, so a planted PIN must still be wiped by the paid activation.
    const anonymous = createCaller(makeCtx());
    await anonymous.app.registerDevice({
      mac: "00:1a:2b:3c:4d:33",
      pin: "111111",
    });
    expect(shared.store.appClients[0]).toMatchObject({
      pinHash: expect.any(String),
      claimedAt: null,
    });
    expect(shared.store.appClients[0].licenseType).toBeUndefined();

    await expect(
      anonymous.clientPortal.login({
        mac: "00:1a:2b:3c:4d:33",
        pin: "111111",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const reseller = makeReseller({ id: 1, credits: 1 });
    shared.store.resellers.push(reseller);
    const activation = await createCaller(
      makeCtx({ reseller })
    ).reseller.activate({
      mac: "00:1a:2b:3c:4d:33",
      licenseType: "12_months",
    });

    expect(activation.claimCode).toBeTruthy();
    expect(shared.store.appClients[0].pinHash).toBeNull();

    await expect(
      anonymous.app.registerDevice({ mac: "00:1a:2b:3c:4d:33", pin: "111111" })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    await expect(
      anonymous.app.registerDevice({
        mac: "00:1a:2b:3c:4d:33",
        pin: "222222",
        claimCode: activation.claimCode!,
      })
    ).resolves.toMatchObject({ verificationRequired: false, activated: true });
    expect(verifySecret("222222", shared.store.appClients[0].pinHash)).toBe(
      true
    );
    expect(verifySecret("111111", shared.store.appClients[0].pinHash)).toBe(
      false
    );
    await expect(
      anonymous.clientPortal.login({
        mac: "00:1a:2b:3c:4d:33",
        pin: "222222",
      })
    ).resolves.toEqual({ success: true });
  });
});

// 2. Password never leaked -------------------------------------------------

describe("admin.resellerCreate — password confidentiality", () => {
  it("never returns the plaintext password; only a scrypt hash is stored", async () => {
    const caller = createCaller(makeCtx({ user: adminUser }));

    const res = await caller.admin.resellerCreate({
      name: "Reseller",
      contact: "wa:+243...",
      username: "newreseller",
      password: "S3cret-Pw!2026",
      initialCredits: 3,
    });

    // Response exposes only id + username — no password/hash.
    expect(res).toEqual({ id: expect.any(Number), username: "newreseller" });
    expect(JSON.stringify(res)).not.toContain("S3cret-Pw!2026");

    // Stored row holds a hash (not the clear value), which verifies correctly.
    const stored = shared.store.resellers.find(
      r => r.username === "newreseller"
    );
    expect(stored.passwordHash).not.toBe("S3cret-Pw!2026");
    expect(stored.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(verifySecret("S3cret-Pw!2026", stored.passwordHash)).toBe(true);

    // A subsequent admin.resellerList never exposes the hash either.
    const list = await caller.admin.resellerList();
    const row = list.find(r => r.username === "newreseller");
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(list)).not.toContain(stored.passwordHash);

    expect(shared.store.creditLedger).toHaveLength(1);
    expect(shared.store.creditLedger[0]).toMatchObject({
      resellerId: stored.id,
      delta: 3,
      balanceAfter: 3,
      entryType: "initial_grant",
      actorType: "admin",
    });
  });
});

describe("admin.resellerAddCredits — atomic balance and ledger", () => {
  it("increments the stored balance and records who added it and why", async () => {
    shared.store.resellers.push(makeReseller({ id: 7, credits: 4 }));
    const result = await createCaller(
      makeCtx({ user: adminUser })
    ).admin.resellerAddCredits({
      resellerId: 7,
      amount: 6,
      reason: "Recharge payée par M-Pesa",
    });

    expect(result).toEqual({ success: true, credits: 10 });
    expect(shared.store.resellers[0].credits).toBe(10);
    expect(shared.store.creditLedger[0]).toMatchObject({
      resellerId: 7,
      delta: 6,
      balanceAfter: 10,
      entryType: "admin_grant",
      actorType: "admin",
      actorUserId: adminUser.id,
      reason: "Recharge payée par M-Pesa",
    });
  });
});

describe("admin.appClientList — client secret confidentiality", () => {
  it("returns an explicit public projection without login or parental PIN hashes", async () => {
    shared.store.appClients.push(
      makeAppClient({
        id: 99,
        activatedByType: "admin",
        activatedByResellerId: null,
        parentalControlPinHash: hashSecret("4321"),
        claimCodeHash: hashSecret("CKAAAAABBBBB"),
      })
    );

    const list = await createCaller(
      makeCtx({ user: adminUser })
    ).admin.appClientList();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 99,
      mac: "aa:bb:cc:dd:ee:ff",
      name: "Salon",
    });
    expect(list[0]).not.toHaveProperty("pinHash");
    expect(list[0]).not.toHaveProperty("parentalControlPinHash");
    expect(list[0]).not.toHaveProperty("claimCodeHash");
  });
});

describe("admin.appClientRenew — transaction and paid-time preservation", () => {
  it("extends an active client from the existing expiry", async () => {
    const existingExpiry = new Date("2027-03-10T00:00:00Z");
    shared.store.appClients.push(
      makeAppClient({
        id: 55,
        expiresAt: existingExpiry,
        activatedByType: "admin",
      })
    );

    const result = await createCaller(
      makeCtx({ user: adminUser })
    ).admin.appClientRenew({
      appClientId: 55,
      licenseType: "12_months",
    });

    expect(result.expiresAt).toEqual(new Date("2028-03-10T00:00:00Z"));
    expect(shared.store.appClients[0].expiresAt).toEqual(
      new Date("2028-03-10T00:00:00Z")
    );
    expect(shared.store.activations).toHaveLength(1);
  });

  it("refuses to downgrade an active unlimited licence", async () => {
    shared.store.appClients.push(
      makeAppClient({ id: 56, licenseType: "unlimited", expiresAt: null })
    );
    await expect(
      createCaller(makeCtx({ user: adminUser })).admin.appClientRenew({
        appClientId: 56,
        licenseType: "12_months",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(shared.store.appClients[0].licenseType).toBe("unlimited");
    expect(shared.store.activations).toHaveLength(0);
  });
});

// 3. Per-reseller isolation ------------------------------------------------

describe("reseller.myActivations — tenant isolation", () => {
  it("returns only the authenticated reseller's activations", async () => {
    const rA = makeReseller({ id: 10, username: "a" });
    const rB = makeReseller({ id: 20, username: "b" });
    shared.store.resellers.push(rA, rB);
    shared.store.activations.push(
      {
        id: 1,
        appClientId: 1,
        mac: "m1",
        licenseType: "12_months",
        creditsCharged: 1,
        activatedByType: "reseller",
        activatedByResellerId: 10,
        createdAt: new Date(),
      },
      {
        id: 2,
        appClientId: 2,
        mac: "m2",
        licenseType: "unlimited",
        creditsCharged: 2,
        activatedByType: "reseller",
        activatedByResellerId: 20,
        createdAt: new Date(),
      },
      {
        id: 3,
        appClientId: 3,
        mac: "m3",
        licenseType: "12_months",
        creditsCharged: 1,
        activatedByType: "reseller",
        activatedByResellerId: 10,
        createdAt: new Date(),
      }
    );

    const listA = await createCaller(
      makeCtx({ reseller: rA })
    ).reseller.myActivations();
    expect(listA.map((a: any) => a.id).sort()).toEqual([1, 3]);
    expect(listA.every((a: any) => a.activatedByResellerId === 10)).toBe(true);

    const listB = await createCaller(
      makeCtx({ reseller: rB })
    ).reseller.myActivations();
    expect(listB.map((a: any) => a.id)).toEqual([2]);
  });

  it("returns only the authenticated reseller's credit ledger", async () => {
    const rA = makeReseller({ id: 10, username: "a" });
    const rB = makeReseller({ id: 20, username: "b" });
    shared.store.creditLedger.push(
      {
        id: 1,
        resellerId: 10,
        delta: 5,
        balanceAfter: 5,
        entryType: "admin_grant",
        actorType: "admin",
        reason: "A",
        createdAt: new Date(),
      },
      {
        id: 2,
        resellerId: 20,
        delta: 9,
        balanceAfter: 9,
        entryType: "admin_grant",
        actorType: "admin",
        reason: "B",
        createdAt: new Date(),
      }
    );

    const listA = await createCaller(
      makeCtx({ reseller: rA })
    ).reseller.creditHistory();
    const listB = await createCaller(
      makeCtx({ reseller: rB })
    ).reseller.creditHistory();
    expect(listA.map((entry: any) => entry.id)).toEqual([1]);
    expect(listB.map((entry: any) => entry.id)).toEqual([2]);
  });
});

describe("reseller.issueClaimCode — ownership", () => {
  it("allows only the reseller who activated the device to reissue its code", async () => {
    const owner = makeReseller({ id: 10, username: "owner" });
    const outsider = makeReseller({ id: 20, username: "outsider" });
    shared.store.appClients.push(
      makeAppClient({
        id: 77,
        pinHash: null,
        claimedAt: null,
        activatedByResellerId: owner.id,
      })
    );

    await expect(
      createCaller(makeCtx({ reseller: outsider })).reseller.issueClaimCode({
        appClientId: 77,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const result = await createCaller(
      makeCtx({ reseller: owner })
    ).reseller.issueClaimCode({
      appClientId: 77,
    });
    expect(result.claimCode).toMatch(/^CK-/);
    expect(shared.store.appClients[0].claimCodeHash).toBeTruthy();
  });
});

// 4. Password change invalidates the old password --------------------------

describe("reseller.changePassword", () => {
  it("makes a login with the old password fail afterwards", async () => {
    const oldPw = "old-password-123";
    const newPw = "new-password-456";
    const reseller = makeReseller({
      id: 1,
      username: "chp",
      passwordHash: hashSecret(oldPw),
    });
    shared.store.resellers.push(reseller);

    // The session context carries the current (old) hash.
    const authenticatedContext = makeCtx({ reseller: { ...reseller } });
    const authed = createCaller(authenticatedContext);
    await expect(
      authed.reseller.changePassword({
        currentPassword: oldPw,
        newPassword: newPw,
      })
    ).resolves.toEqual({ success: true });
    expect(authenticatedContext.resHeaders.get("set-cookie")).toContain(
      "ck_reseller_sid=;"
    );
    expect(authenticatedContext.resHeaders.get("set-cookie")).toContain(
      "Max-Age=0"
    );

    // The stored hash now matches only the new password.
    expect(verifySecret(newPw, shared.store.resellers[0].passwordHash)).toBe(
      true
    );
    expect(verifySecret(oldPw, shared.store.resellers[0].passwordHash)).toBe(
      false
    );

    const anon = createCaller(makeCtx());
    await expect(
      anon.reseller.login({ username: "chp", password: oldPw })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anon.reseller.login({ username: "chp", password: newPw })
    ).resolves.toEqual({ success: true });
  });
});

// ---------------------------------------------------------------------------
// CinéKin Player device API (wave 2A).
// The per-MAC lockout counters live in module-level stores that beforeEach
// does not reset: every test below uses its own MACs and IPs.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function deviceCaller(clientIp = "203.0.113.1") {
  return createCaller(makeCtx({ clientIp }));
}

describe("registerDevice — CinéKin Player trust and 7-day trial", () => {
  it("trusts a locally administered MAC and starts a 7-day trial", async () => {
    const before = Date.now();
    const result = await deviceCaller().app.registerDevice({
      mac: "6E:63:F8:C4:03:0A",
      pin: "135790",
    });

    const stored = shared.store.appClients[0];
    expect(stored.mac).toBe("6e:63:f8:c4:03:0a");
    expect(verifySecret("135790", stored.pinHash)).toBe(true);
    expect(stored.claimedAt).toBeInstanceOf(Date);
    expect(stored.trialStartedAt).toBeInstanceOf(Date);
    expect(stored.trialEndsAt.getTime() - stored.trialStartedAt.getTime()).toBe(
      TRIAL_DURATION_DAYS * DAY_MS
    );
    expect(stored.trialStartedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result).toEqual({
      registered: true,
      activated: false,
      alreadyKnown: false,
      verificationRequired: false,
      status: "trial",
      trialEndsAt: stored.trialEndsAt.toISOString(),
    });

    // The client portal requires claimedAt: it works during the trial.
    await expect(
      deviceCaller().clientPortal.login({
        mac: "6e:63:f8:c4:03:0a",
        pin: "135790",
      })
    ).resolves.toEqual({ success: true });
  });

  it("never restarts nor extends the trial when the same device registers again", async () => {
    const anonymous = deviceCaller();
    await anonymous.app.registerDevice({ mac: "02:aa:00:00:00:01", pin: "111222" });
    const stored = shared.store.appClients[0];
    const startedAt = stored.trialStartedAt.getTime();
    const endsAt = stored.trialEndsAt.getTime();

    await expect(
      anonymous.app.registerDevice({ mac: "02-AA-00-00-00-01", pin: "111222" })
    ).resolves.toMatchObject({
      alreadyKnown: true,
      verificationRequired: false,
      status: "trial",
      trialEndsAt: new Date(endsAt).toISOString(),
    });
    expect(shared.store.appClients).toHaveLength(1);
    expect(stored.trialStartedAt.getTime()).toBe(startedAt);
    expect(stored.trialEndsAt.getTime()).toBe(endsAt);
  });

  it("refuses a wrong PIN for a known device and mutates nothing", async () => {
    const anonymous = deviceCaller();
    await anonymous.app.registerDevice({ mac: "02:aa:00:00:00:02", pin: "111222" });
    const pinHash = shared.store.appClients[0].pinHash;

    await expect(
      anonymous.app.registerDevice({ mac: "02:aa:00:00:00:02", pin: "999999" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(shared.store.appClients[0].pinHash).toBe(pinHash);
  });

  it("leaves a legacy row (PIN but no claimedAt) untrusted and without trial", async () => {
    // Legacy rows predate migration 0001: even with a local MAC they stay
    // untrusted until a one-time code is used.
    shared.store.appClients.push(
      makeAppClient({
        id: 900,
        mac: "02:aa:00:00:00:03",
        pinHash: hashSecret("246802"),
        claimedAt: null,
        licenseType: null,
        activatedByType: null,
        activatedByResellerId: null,
        activatedAt: null,
        expiresAt: null,
      })
    );

    await expect(
      deviceCaller().app.registerDevice({ mac: "02:aa:00:00:00:03", pin: "246802" })
    ).resolves.toMatchObject({
      alreadyKnown: true,
      verificationRequired: true,
      status: "inactive",
      trialEndsAt: null,
    });
    const stored = shared.store.appClients[0];
    expect(stored.claimedAt).toBeNull();
    expect(stored.trialEndsAt).toBeNull();
    await expect(
      deviceCaller().app.deviceStatus({ mac: "02:aa:00:00:00:03", pin: "246802" })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: DEVICE_CREDENTIALS_ERROR,
    });
  });

  it("keeps a hardware MAC untrusted: no trial, and a paid activation still wipes the planted PIN", async () => {
    const anonymous = deviceCaller();
    await expect(
      anonymous.app.registerDevice({ mac: "00:1A:2B:3C:4D:5E", pin: "111111" })
    ).resolves.toMatchObject({
      alreadyKnown: false,
      verificationRequired: true,
      status: "inactive",
      trialEndsAt: null,
    });
    const stored = shared.store.appClients[0];
    expect(stored.claimedAt).toBeNull();
    expect(stored.trialStartedAt).toBeNull();
    expect(stored.trialEndsAt).toBeNull();

    await expect(
      anonymous.app.deviceStatus({ mac: "00:1a:2b:3c:4d:5e", pin: "111111" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const reseller = makeReseller({ id: 1, credits: 1 });
    shared.store.resellers.push(reseller);
    const activation = await createCaller(
      makeCtx({ reseller })
    ).reseller.activate({ mac: "00:1a:2b:3c:4d:5e", licenseType: "12_months" });
    expect(activation.claimCode).toBeTruthy();
    expect(shared.store.appClients[0].pinHash).toBeNull();
  });

  it("still requires the one-time code for a pre-activated local MAC", async () => {
    const reseller = makeReseller({ id: 1, credits: 1 });
    shared.store.resellers.push(reseller);
    const activation = await createCaller(
      makeCtx({ reseller })
    ).reseller.activate({ mac: "02:aa:00:00:00:04", licenseType: "12_months" });
    expect(activation.claimCode).toBeTruthy();

    await expect(
      deviceCaller().app.registerDevice({ mac: "02:aa:00:00:00:04", pin: "123123" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(shared.store.appClients[0].pinHash).toBeUndefined();
  });

  it("lets a reseller activate a device during its trial without wiping it nor adding the trial", async () => {
    await deviceCaller().app.registerDevice({ mac: "02:aa:00:00:00:05", pin: "777888" });
    const stored = shared.store.appClients[0];
    const trialEndsAt = stored.trialEndsAt.getTime();
    const reseller = makeReseller({ id: 1, credits: 1 });
    shared.store.resellers.push(reseller);

    const before = new Date();
    const activation = await createCaller(
      makeCtx({ reseller })
    ).reseller.activate({ mac: "02:aa:00:00:00:05", licenseType: "12_months" });
    const after = new Date();

    // claimedAt is set: no code, the device keeps its PIN.
    expect(activation.claimCode).toBeNull();
    expect(verifySecret("777888", stored.pinHash)).toBe(true);
    // The licence starts at activation time; trial days are not added.
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(
      computeExpiry("12_months", before)!.getTime()
    );
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(
      computeExpiry("12_months", after)!.getTime()
    );
    expect(stored.trialEndsAt.getTime()).toBe(trialEndsAt);
    await expect(
      deviceCaller().app.deviceStatus({ mac: "02:aa:00:00:00:05", pin: "777888" })
    ).resolves.toMatchObject({ status: "active", licenseType: "12_months" });
  });

  it("lets an admin activate a device during its trial without a code", async () => {
    await deviceCaller().app.registerDevice({ mac: "02:aa:00:00:00:06", pin: "777888" });
    const result = await createCaller(
      makeCtx({ user: adminUser })
    ).admin.appClientActivate({ mac: "02:aa:00:00:00:06", licenseType: "unlimited" });

    expect(result).toMatchObject({ claimCode: null });
    expect(verifySecret("777888", shared.store.appClients[0].pinHash)).toBe(true);
    expect(shared.store.appClients[0].licenseType).toBe("unlimited");
  });
});

describe("app.deviceStatus / app.devicePlaylists", () => {
  function trustedClient(over: Partial<AppClient>) {
    const client = makeAppClient({
      claimedAt: new Date(),
      pinHash: hashSecret("424242"),
      licenseType: null,
      activatedByType: null,
      activatedByResellerId: null,
      activatedAt: null,
      expiresAt: null,
      ...over,
    });
    shared.store.appClients.push(client);
    return client;
  }

  function seedPlaylists(appClientId: number) {
    shared.store.playlists.push(
      {
        id: 501,
        appClientId,
        name: "Bouquet Xtream",
        format: "xtream",
        source: "cinekin",
        m3uUrl: null,
        xtreamServerUrl: encryptSecret("https://xtream.example.test:8080"),
        xtreamUsername: encryptSecret("user-42"),
        xtreamPassword: encryptSecret("s3cret-pass"),
        createdAt: new Date(),
      },
      {
        id: 502,
        appClientId,
        name: "Liste M3U",
        format: "m3u",
        source: "external",
        m3uUrl: "https://m3u.example.test/list.m3u",
        xtreamServerUrl: null,
        xtreamUsername: null,
        xtreamPassword: null,
        createdAt: new Date(),
      }
    );
  }

  it("reports a running trial with ISO dates and forbids caching", async () => {
    const trialEndsAt = new Date(Date.now() + 3 * DAY_MS);
    trustedClient({ mac: "02:bb:00:00:00:01", trialEndsAt });
    const ctx = makeCtx({ clientIp: "203.0.113.2" });

    const before = Date.now();
    const result = await createCaller(ctx).app.deviceStatus({
      mac: "02:BB:00:00:00:01",
      pin: "424242",
    });

    expect(result).toEqual({
      status: "trial",
      licenseType: null,
      expiresAt: null,
      trialEndsAt: trialEndsAt.toISOString(),
      serverTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(new Date(result.serverTime).getTime()).toBeGreaterThanOrEqual(before);
    expect(ctx.resHeaders.get("cache-control")).toBe("no-store");
  });

  it.each([
    [
      "active",
      "02:bb:00:00:01:01",
      { licenseType: "12_months" as const, expiresAt: new Date(Date.now() + DAY_MS) },
    ],
    [
      "expired",
      "02:bb:00:00:01:02",
      { licenseType: "12_months" as const, expiresAt: new Date(Date.now() - DAY_MS) },
    ],
    ["expired", "02:bb:00:00:01:03", { trialEndsAt: new Date(Date.now() - DAY_MS) }],
    ["inactive", "02:bb:00:00:01:04", {}],
  ])("reports %s (%s)", async (expected, mac, over) => {
    trustedClient({ mac, ...over });
    await expect(
      deviceCaller().app.deviceStatus({ mac, pin: "424242" })
    ).resolves.toMatchObject({ status: expected });
  });

  it("returns decrypted playlists for a device in trial", async () => {
    const client = trustedClient({
      mac: "02:bb:00:00:00:02",
      trialEndsAt: new Date(Date.now() + DAY_MS),
    });
    seedPlaylists(client.id);
    const ctx = makeCtx({ clientIp: "203.0.113.3" });

    const result = await createCaller(ctx).app.devicePlaylists({
      mac: "02:bb:00:00:00:02",
      pin: "424242",
    });

    expect(result.status).toBe("trial");
    expect(ctx.resHeaders.get("cache-control")).toBe("no-store");
    expect(result.playlists).toEqual(
      expect.arrayContaining([
        {
          id: 501,
          name: "Bouquet Xtream",
          format: "xtream",
          source: "cinekin",
          m3uUrl: null,
          xtreamServerUrl: "https://xtream.example.test:8080",
          xtreamUsername: "user-42",
          xtreamPassword: "s3cret-pass",
        },
        {
          id: 502,
          name: "Liste M3U",
          format: "m3u",
          source: "external",
          m3uUrl: "https://m3u.example.test/list.m3u",
          xtreamServerUrl: null,
          xtreamUsername: null,
          xtreamPassword: null,
        },
      ])
    );
  });

  it("returns decrypted playlists for an active licence", async () => {
    const client = trustedClient({
      mac: "02:bb:00:00:00:03",
      licenseType: "unlimited",
    });
    seedPlaylists(client.id);
    const result = await deviceCaller().app.devicePlaylists({
      mac: "02:bb:00:00:00:03",
      pin: "424242",
    });
    expect(result.status).toBe("active");
    expect(result.playlists).toHaveLength(2);
  });

  it.each([
    ["an expired licence", { licenseType: "12_months" as const, expiresAt: new Date(Date.now() - DAY_MS) }, "02:bb:00:00:00:04"],
    ["a finished trial", { trialEndsAt: new Date(Date.now() - DAY_MS) }, "02:bb:00:00:00:05"],
    ["no licence nor trial", {}, "02:bb:00:00:00:06"],
  ])("returns no playlist and no credential for %s", async (_label, over, mac) => {
    const client = trustedClient({ mac, ...over });
    seedPlaylists(client.id);

    const result = await deviceCaller().app.devicePlaylists({ mac, pin: "424242" });

    expect(result.playlists).toEqual([]);
    const serialised = JSON.stringify(result);
    for (const secret of [
      "s3cret-pass",
      "user-42",
      "xtream.example.test",
      "m3u.example.test",
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("answers unknown MAC, wrong PIN and untrusted row with the same error", async () => {
    trustedClient({ mac: "02:bb:00:00:00:07", trialEndsAt: new Date(Date.now() + DAY_MS) });
    trustedClient({
      id: 901,
      mac: "02:bb:00:00:00:08",
      claimedAt: null,
      trialEndsAt: new Date(Date.now() + DAY_MS),
    });
    const anonymous = deviceCaller();

    const attempts = [
      anonymous.app.deviceStatus({ mac: "02:bb:00:00:00:99", pin: "424242" }),
      anonymous.app.deviceStatus({ mac: "02:bb:00:00:00:07", pin: "000000" }),
      anonymous.app.deviceStatus({ mac: "02:bb:00:00:00:08", pin: "424242" }),
      anonymous.app.devicePlaylists({ mac: "02:bb:00:00:00:99", pin: "424242" }),
      anonymous.app.devicePlaylists({ mac: "02:bb:00:00:00:07", pin: "000000" }),
      anonymous.app.devicePlaylists({ mac: "02:bb:00:00:00:08", pin: "424242" }),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: DEVICE_CREDENTIALS_ERROR,
      });
    }
  });
});

describe("per-MAC PIN lockout", () => {
  async function registerTrialDevice(mac: string, pin = "314159") {
    await deviceCaller().app.registerDevice({ mac, pin });
  }

  async function failTimes(mac: string, times: number, clientIp?: string) {
    for (let i = 0; i < times; i += 1) {
      await expect(
        deviceCaller(clientIp).app.deviceStatus({ mac, pin: "000000" })
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  }

  it(`locks the MAC after ${DEVICE_PIN_MAX_FAILURES} failures, even with the right PIN`, async () => {
    await registerTrialDevice("02:cc:00:00:00:01");
    await failTimes("02:cc:00:00:00:01", DEVICE_PIN_MAX_FAILURES);

    for (const call of [
      deviceCaller().app.deviceStatus({ mac: "02:cc:00:00:00:01", pin: "314159" }),
      deviceCaller().app.devicePlaylists({ mac: "02:cc:00:00:00:01", pin: "314159" }),
      deviceCaller().app.registerDevice({ mac: "02:cc:00:00:00:01", pin: "314159" }),
    ]) {
      await expect(call).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: DEVICE_LOCKED_MESSAGE,
      });
    }
  });

  it("resets the failure counter after a successful PIN", async () => {
    await registerTrialDevice("02:cc:00:00:00:02");
    await failTimes("02:cc:00:00:00:02", DEVICE_PIN_MAX_FAILURES - 1);
    await expect(
      deviceCaller().app.deviceStatus({ mac: "02:cc:00:00:00:02", pin: "314159" })
    ).resolves.toMatchObject({ status: "trial" });

    await failTimes("02:cc:00:00:00:02", DEVICE_PIN_MAX_FAILURES - 1);
    await expect(
      deviceCaller().app.deviceStatus({ mac: "02:cc:00:00:00:02", pin: "314159" })
    ).resolves.toMatchObject({ status: "trial" });
  });

  it("counts failures per MAC whatever the IP", async () => {
    await registerTrialDevice("02:cc:00:00:00:03");
    for (let i = 0; i < DEVICE_PIN_MAX_FAILURES; i += 1) {
      await failTimes("02:cc:00:00:00:03", 1, `198.51.100.${i + 1}`);
    }
    await expect(
      deviceCaller("192.0.2.99").app.deviceStatus({
        mac: "02:cc:00:00:00:03",
        pin: "314159",
      })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("does not affect other devices", async () => {
    await registerTrialDevice("02:cc:00:00:00:04");
    await registerTrialDevice("02:cc:00:00:00:05");
    await failTimes("02:cc:00:00:00:04", DEVICE_PIN_MAX_FAILURES);

    await expect(
      deviceCaller().app.deviceStatus({ mac: "02:cc:00:00:00:05", pin: "314159" })
    ).resolves.toMatchObject({ status: "trial" });
  });

  it("counts wrong PINs sent to registerDevice", async () => {
    await registerTrialDevice("02:cc:00:00:00:06");
    for (let i = 0; i < DEVICE_PIN_MAX_FAILURES; i += 1) {
      await expect(
        deviceCaller().app.registerDevice({ mac: "02:cc:00:00:00:06", pin: "000000" })
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    await expect(
      deviceCaller().app.deviceStatus({ mac: "02:cc:00:00:00:06", pin: "314159" })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("counts failures on an unknown MAC so the lockout reveals nothing", async () => {
    await failTimes("02:cc:00:00:00:07", DEVICE_PIN_MAX_FAILURES);
    await expect(
      deviceCaller().app.deviceStatus({ mac: "02:cc:00:00:00:07", pin: "000000" })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("registerDevice — new devices per IP", () => {
  it(`refuses the ${NEW_DEVICES_PER_IP_LIMIT + 1}th new device from one IP`, async () => {
    // Pre-fill the counter instead of hashing 100 PINs.
    for (let i = 0; i < NEW_DEVICES_PER_IP_LIMIT; i += 1) {
      await newDevicesPerIpStore.increment("203.0.113.200");
    }

    await expect(
      deviceCaller("203.0.113.200").app.registerDevice({
        mac: "02:dd:00:00:00:01",
        pin: "123456",
      })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(shared.store.appClients).toHaveLength(0);

    await expect(
      deviceCaller("203.0.113.201").app.registerDevice({
        mac: "02:dd:00:00:00:01",
        pin: "123456",
      })
    ).resolves.toMatchObject({ status: "trial" });
  });

  it("counts only creations, not re-registrations of a known device", async () => {
    const ip = "203.0.113.210";
    await deviceCaller(ip).app.registerDevice({ mac: "02:dd:00:00:00:02", pin: "123456" });
    for (let i = 0; i < 3; i += 1) {
      await deviceCaller(ip).app.registerDevice({ mac: "02:dd:00:00:00:02", pin: "123456" });
    }
    const counter = await newDevicesPerIpStore.get!(ip);
    expect(counter?.totalHits).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  autoEmail,
  claimCodeSchema,
  computeRenewalExpiry,
  computeTrialEndsAt,
  generateClaimCode,
  isCinekinPlayerDeviceId,
  licenseStatus,
  macAddressSchema,
  macLookupVariants,
  normalizeMac,
  TRIAL_DURATION_DAYS,
} from "./app-license";

describe("MAC address canonicalisation", () => {
  it.each([
    "AA:BB:CC:DD:EE:FF",
    "aa-bb-cc-dd-ee-ff",
    "AABBCCDDEEFF",
  ])("normalises %s to one stored representation", (input) => {
    expect(normalizeMac(input)).toBe("aa:bb:cc:dd:ee:ff");
    expect(macAddressSchema.parse(input)).toBe("aa:bb:cc:dd:ee:ff");
  });

  it.each([
    "aa:bb:cc",
    "aa:bb:cc:dd:ee:gg",
    "aa-bb:cc-dd:ee-ff",
    "0:abb:cc:dd:ee:ff",
    "aa bb cc dd ee ff",
    "",
  ])("rejects malformed input %j", (input) => {
    expect(normalizeMac(input)).toBe("");
    expect(macAddressSchema.safeParse(input).success).toBe(false);
  });

  it("uses the canonical MAC in generated fallback emails", () => {
    expect(autoEmail(undefined, "AA-BB-CC-DD-EE-FF")).toBe(
      "client-aabbccddeeff@client.cine-kin.tv",
    );
  });

  it("keeps generated emails unique even when two clients share the same name", () => {
    expect(autoEmail("Jean Client", "00:11:22:33:44:55")).toBe(
      "jean-client-001122334455@client.cine-kin.tv",
    );
    expect(autoEmail("Jean Client", "00:11:22:33:44:66")).toBe(
      "jean-client-001122334466@client.cine-kin.tv",
    );
  });

  it("keeps legacy stored representations discoverable during migration", () => {
    expect(macLookupVariants("AA-BB-CC-DD-EE-FF")).toEqual([
      "aa:bb:cc:dd:ee:ff",
      "aabbccddeeff",
      "aa-bb-cc-dd-ee-ff",
    ]);
  });
});

describe("licence renewal and claim codes", () => {
  it("extends a still-active annual licence from its current expiry", () => {
    const now = new Date("2026-08-20T12:00:00Z");
    const currentExpiry = new Date("2027-01-15T12:00:00Z");
    expect(computeRenewalExpiry("12_months", now, currentExpiry)).toEqual(
      new Date("2028-01-15T12:00:00Z"),
    );
  });

  it("restarts an expired annual licence from now and keeps unlimited without expiry", () => {
    const now = new Date("2026-08-20T12:00:00Z");
    expect(
      computeRenewalExpiry("12_months", now, new Date("2026-01-01T00:00:00Z")),
    ).toEqual(new Date("2027-08-20T12:00:00Z"));
    expect(computeRenewalExpiry("unlimited", now, new Date("2030-01-01T00:00:00Z"))).toBeNull();
  });

  it("generates a strong human-readable code accepted by the API schema", () => {
    const code = generateClaimCode();
    expect(code).toMatch(/^CK-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(claimCodeSchema.parse(code)).toMatch(/^CK[A-HJ-NP-Z2-9]{10}$/);
  });
});

describe("licenseStatus — licence and trial matrix", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");
  const past = new Date("2026-10-01T00:00:00.000Z");
  const future = new Date("2026-12-01T00:00:00.000Z");

  it.each([
    ["no licence, no trial", null, null, null, "inactive"],
    ["no licence, trial running", null, null, future, "trial"],
    ["no licence, trial finished", null, null, past, "expired"],
    ["active 12-month licence", "12_months", future, null, "active"],
    ["expired 12-month licence", "12_months", past, null, "expired"],
    ["unlimited licence", "unlimited", null, null, "active"],
    ["licence wins over a running trial", "12_months", future, future, "active"],
    ["expired licence wins over a running trial", "12_months", past, future, "expired"],
    ["unlimited wins over a finished trial", "unlimited", null, past, "active"],
  ] as const)("%s → %s", (_label, licenseType, expiresAt, trialEndsAt, expected) => {
    expect(licenseStatus({ licenseType, expiresAt, trialEndsAt }, now)).toBe(
      expected
    );
  });

  it("ends the trial exactly at trialEndsAt", () => {
    expect(
      licenseStatus({ licenseType: null, expiresAt: null, trialEndsAt: now }, now)
    ).toBe("expired");
  });
});

describe("free trial duration", () => {
  it("lasts exactly seven days from the server clock", () => {
    const start = new Date("2026-11-01T10:00:00.000Z");
    expect(TRIAL_DURATION_DAYS).toBe(7);
    expect(computeTrialEndsAt(start).toISOString()).toBe(
      "2026-11-08T10:00:00.000Z"
    );
  });
});

describe("isCinekinPlayerDeviceId", () => {
  it("accepts the real MAC vector produced by the CinéKin Player app", () => {
    expect(macAddressSchema.parse("6E:63:F8:C4:03:0A")).toBe(
      "6e:63:f8:c4:03:0a"
    );
    expect(isCinekinPlayerDeviceId("6E:63:F8:C4:03:0A")).toBe(true);
  });

  it.each([
    "6E:63:F8:C4:03:0A",
    "6e:63:f8:c4:03:0a",
    "6E-63-F8-C4-03-0A",
    "6E63F8C4030A",
    " 6e:63:f8:c4:03:0a ",
  ])("recognises the same device whatever the spelling: %j", (mac) => {
    expect(isCinekinPlayerDeviceId(mac)).toBe(true);
  });

  it.each([
    ["02:00:00:00:00:00", true],
    ["fe:ff:ff:ff:ff:ff", true],
    // Globally administered (real network card, label MAC): bit 0x02 is 0.
    ["00:1a:2b:3c:4d:5e", false],
    ["fc:00:00:00:00:00", false],
    // Multicast bit (0x01) set: never a device address, even if local.
    ["03:00:00:00:00:00", false],
    ["ff:ff:ff:ff:ff:ff", false],
    ["01:00:5e:00:00:01", false],
  ])("%s → %s", (mac, expected) => {
    expect(isCinekinPlayerDeviceId(mac)).toBe(expected);
  });

  it.each(["", "6e:63:f8", "zz:63:f8:c4:03:0a", "6e:63-f8:c4:03:0a"])(
    "rejects malformed input %j",
    (mac) => {
      expect(isCinekinPlayerDeviceId(mac)).toBe(false);
    }
  );
});

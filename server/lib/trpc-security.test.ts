import { describe, expect, it } from "vitest";
import {
  hasAllowedOrigin,
  isDeviceApiTrpcRequest,
  isHumanLoginTrpcRequest,
  isSensitiveTrpcBatch,
  isSensitiveTrpcRequest,
  sensitiveProcedureKey,
  trpcProcedureNames,
} from "./trpc-security";

describe("tRPC authentication transport guard", () => {
  it("extracts single and batched procedure names", () => {
    expect(
      trpcProcedureNames("https://cine.test/api/trpc/auth.adminLogin")
    ).toEqual(["auth.adminLogin"]);
    expect(
      trpcProcedureNames(
        "https://cine.test/api/trpc/auth.adminLogin,reseller.login?batch=1"
      )
    ).toEqual(["auth.adminLogin", "reseller.login"]);
  });

  it.each([
    "auth.adminLogin",
    "clientPortal.login",
    "reseller.login",
    "app.registerDevice",
  ])("classifies %s as sensitive", procedure => {
    const url = `https://cine.test/api/trpc/${procedure}`;
    expect(isSensitiveTrpcRequest(url)).toBe(true);
    expect(sensitiveProcedureKey(url)).toBe(procedure);
  });

  it("rejects both explicit and comma-separated batching for sensitive procedures", () => {
    expect(
      isSensitiveTrpcBatch("https://cine.test/api/trpc/auth.adminLogin?batch=1")
    ).toBe(true);
    expect(
      isSensitiveTrpcBatch(
        "https://cine.test/api/trpc/auth.adminLogin,auth.adminLogin"
      )
    ).toBe(true);
    expect(
      isSensitiveTrpcBatch("https://cine.test/api/trpc/auth.adminLogin")
    ).toBe(false);
    expect(
      isSensitiveTrpcBatch("https://cine.test/api/trpc/ping?batch=1")
    ).toBe(false);
  });
});

describe("same-origin browser guard", () => {
  it("accepts a matching browser origin", () => {
    const headers = new Headers({
      host: "cine.test",
      origin: "https://cine.test",
    });
    expect(hasAllowedOrigin(headers, "https://cine.test/api/trpc/ping")).toBe(
      true
    );
  });

  it("uses the forwarded host behind a proxy", () => {
    const headers = new Headers({
      host: "internal.local",
      "x-forwarded-host": "cine.example, proxy.local",
      "x-forwarded-proto": "https",
      origin: "https://cine.example",
    });
    expect(
      hasAllowedOrigin(headers, "http://internal.local/api/trpc/ping", true)
    ).toBe(true);
  });

  it("ignores spoofed forwarded origin data when proxy trust is disabled", () => {
    const headers = new Headers({
      host: "cine.test",
      "x-forwarded-host": "attacker.test",
      "x-forwarded-proto": "https",
      origin: "https://attacker.test",
    });
    expect(hasAllowedOrigin(headers, "https://cine.test/api/trpc/ping")).toBe(
      false
    );
  });

  it("rejects a different origin scheme even when the host matches", () => {
    const headers = new Headers({
      host: "cine.test",
      origin: "http://cine.test",
    });
    expect(hasAllowedOrigin(headers, "https://cine.test/api/trpc/ping")).toBe(
      false
    );
  });

  it("rejects a cross-site browser origin", () => {
    const headers = new Headers({
      host: "cine.test",
      origin: "https://attacker.test",
    });
    expect(hasAllowedOrigin(headers, "https://cine.test/api/trpc/ping")).toBe(
      false
    );
  });

  it("allows native clients that do not send Origin", () => {
    const headers = new Headers({ host: "cine.test" });
    expect(hasAllowedOrigin(headers, "https://cine.test/api/trpc/ping")).toBe(
      true
    );
  });
});

describe("device API procedures", () => {
  const deviceProcedures = [
    "app.registerDevice",
    "app.deviceStatus",
    "app.devicePlaylists",
  ];

  it.each(deviceProcedures)("treats %s as sensitive: batching is forbidden", name => {
    const url = `https://cine.test/api/trpc/${name}`;
    expect(isSensitiveTrpcRequest(url)).toBe(true);
    expect(isSensitiveTrpcBatch(`${url}?batch=1`)).toBe(true);
    expect(isSensitiveTrpcBatch(`${url},${name}`)).toBe(true);
    expect(sensitiveProcedureKey(url)).toBe(name);
  });

  it.each(deviceProcedures)(
    "gives %s the device quota, not the strict human-login quota",
    name => {
      const url = `https://cine.test/api/trpc/${name}`;
      expect(isDeviceApiTrpcRequest(url)).toBe(true);
      expect(isHumanLoginTrpcRequest(url)).toBe(false);
    }
  );

  it.each(["auth.adminLogin", "clientPortal.login", "reseller.login"])(
    "keeps %s under the strict human-login quota",
    name => {
      const url = `https://cine.test/api/trpc/${name}`;
      expect(isHumanLoginTrpcRequest(url)).toBe(true);
      expect(isDeviceApiTrpcRequest(url)).toBe(false);
    }
  );
});

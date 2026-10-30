// Shared formatting for the admin licence panel. Kept in sync with the
// server-side rules in api/lib/app-license.ts (labels/status/credit cost).

export type LicenseType = "12_months" | "unlimited" | null;
export type LicenseStatus = "inactive" | "trial" | "active" | "expired";

export function licenseLabel(type: LicenseType): string {
  if (type === "12_months") return "12 mois";
  if (type === "unlimited") return "Illimitée";
  return "—";
}

// 1 credit = 12 months, 2 credits = unlimited.
export function creditCost(type: Exclude<LicenseType, null>): number {
  return type === "unlimited" ? 2 : 1;
}

export function normalizeMac(mac: string): string {
  const value = mac.trim();
  const valid =
    /^(?:[0-9a-f]{12}|[0-9a-f]{2}(?::[0-9a-f]{2}){5}|[0-9a-f]{2}(?:-[0-9a-f]{2}){5})$/i.test(
      value
    );
  if (!valid) return "";
  const compact = value.replace(/[:-]/g, "").toLowerCase();
  return compact.match(/.{2}/g)?.join(":") ?? "";
}

export function isValidMac(mac: string): boolean {
  return normalizeMac(mac) !== "";
}

export function formatMacInput(raw: string): string {
  const hex = raw
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase()
    .slice(0, 12);
  return hex.match(/.{1,2}/g)?.join(":") ?? "";
}

// Same priority as the server: licence first, then the free trial.
export function computeStatus(client: {
  licenseType: LicenseType;
  expiresAt: Date | string | null;
  trialEndsAt: Date | string | null;
}): LicenseStatus {
  if (client.licenseType) {
    if (client.licenseType === "unlimited" || !client.expiresAt) return "active";
    return new Date(client.expiresAt).getTime() > Date.now()
      ? "active"
      : "expired";
  }
  if (client.trialEndsAt) {
    return new Date(client.trialEndsAt).getTime() > Date.now()
      ? "trial"
      : "expired";
  }
  return "inactive";
}

export function statusMeta(
  status: LicenseStatus,
  trialEndsAt?: Date | string | null
): {
  label: string;
  className: string;
} {
  switch (status) {
    case "trial":
      return {
        label: trialEndsAt
          ? `Essai jusqu'au ${formatDate(trialEndsAt)}`
          : "Essai",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-400",
      };
    case "active":
      return {
        label: "Active",
        className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
      };
    case "expired":
      return {
        label: "Expirée",
        className: "border-red-500/30 bg-red-500/10 text-red-400",
      };
    default:
      return {
        label: "Inactive",
        className: "border-white/15 bg-white/5 text-white/50",
      };
  }
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

import { ChevronRight, CreditCard, ListVideo, ShieldCheck } from "lucide-react";
import { licenseLabel, formatDate } from "./format";
import type { ClientView } from "./ClientPortal";

type Dashboard = {
  mac: string;
  name: string | null;
  licenseType: "12_months" | "unlimited" | null;
  status: "inactive" | "trial" | "active" | "expired";
  expiresAt: Date | string | null;
  trialEndsAt: Date | string | null;
  parentalControlEnabled: boolean;
  playlistCount: number;
};

export default function DashboardView({
  dashboard,
  onNavigate,
}: {
  dashboard: Dashboard;
  onNavigate: (v: ClientView) => void;
}) {
  const isTrial = dashboard.status === "trial";
  const inactive = dashboard.status === "inactive";
  const expired = dashboard.status === "expired";
  // An expired status without any licence means the free trial has ended.
  const trialEnded = expired && dashboard.licenseType === null;

  const statusBadge = isTrial
    ? { label: "Essai", className: "border-amber-500/30 bg-amber-500/10 text-amber-400" }
    : inactive
      ? { label: "Inactive", className: "border-white/15 bg-white/5 text-white/50" }
      : expired
        ? { label: "Expirée", className: "border-red-500/30 bg-red-500/10 text-red-400" }
        : { label: "Active", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" };

  const expiryLine = isTrial
    ? `Essai jusqu'au ${formatDate(dashboard.trialEndsAt)}`
    : inactive
      ? "Aucune licence active — activez votre abonnement."
      : trialEnded
        ? `Essai terminé le ${formatDate(dashboard.trialEndsAt)} — activez votre abonnement.`
        : dashboard.licenseType === "unlimited" || !dashboard.expiresAt
          ? "Aucune expiration"
          : `${expired ? "Expirée le" : "Active jusqu'au"} ${formatDate(dashboard.expiresAt)}`;

  const tiles: { view: ClientView; icon: typeof ListVideo; label: string; hint: string }[] = [
    {
      view: "playlists",
      icon: ListVideo,
      label: "Playlists",
      hint: `${dashboard.playlistCount} playlist${dashboard.playlistCount > 1 ? "s" : ""}`,
    },
    {
      view: "parental",
      icon: ShieldCheck,
      label: "Contrôle parental",
      hint: dashboard.parentalControlEnabled ? "Activé" : "Non configuré",
    },
    { view: "payment", icon: CreditCard, label: "Paiement", hint: "Gérer l'abonnement" },
  ];

  return (
    <div className="space-y-6">
      {/* Status card */}
      <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-br from-[#5a6b4e]/12 to-transparent p-6">
        <div className="flex items-center justify-between">
          <span className="text-sm uppercase tracking-wide text-white/50">Ma formule</span>
          <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${statusBadge.className}`}>
            {statusBadge.label}
          </span>
        </div>
        <div className="mt-2 font-display text-3xl font-bold text-white">
          {licenseLabel(dashboard.licenseType)}
        </div>
        <p className="mt-1 text-sm text-white/55">{expiryLine}</p>
        <p className="mt-4 font-mono text-xs text-white/40">{dashboard.mac}</p>
      </div>

      {/* Tiles */}
      <div className="grid gap-4 sm:grid-cols-3">
        {tiles.map((t) => (
          <button
            key={t.view}
            onClick={() => onNavigate(t.view)}
            className="group flex items-center gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 text-left transition-colors hover:border-[#5a6b4e]/40 hover:bg-white/[0.04] sm:flex-col sm:items-start"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#5a6b4e]/15 text-[#8ba26f]">
              <t.icon className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-1 font-medium text-white">
                {t.label}
                <ChevronRight className="h-4 w-4 text-white/30 transition-transform group-hover:translate-x-0.5" />
              </div>
              <div className="text-sm text-white/50">{t.hint}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

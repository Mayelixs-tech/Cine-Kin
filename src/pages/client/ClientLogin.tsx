import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { MonitorSmartphone } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatMacInput, isValidMac } from "@/lib/licenseFormat";

export default function ClientLogin() {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [searchParams] = useSearchParams();
  // /activation?mac=… (link and QR code shown by the CinéKin Player app)
  // pre-fills the MAC, only when it is a valid MAC. The PIN is NEVER read from
  // the URL: it would leak through history, logs and screenshots.
  const [mac, setMac] = useState(() => {
    const fromUrl = searchParams.get("mac");
    return fromUrl && isValidMac(fromUrl) ? formatMacInput(fromUrl) : "";
  });
  const [pin, setPin] = useState("");

  const login = trpc.clientPortal.login.useMutation({
    onSuccess: async () => {
      await utils.clientPortal.getDashboard.invalidate();
    },
    onError: e => toast(e.message || "Connexion impossible", "error"),
  });

  const macComplete = isValidMac(mac);
  const pinComplete = pin.length === 6;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!macComplete || !pinComplete) return;
    login.mutate({ mac, pin });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a1628] px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[#5a6b4e]/15 text-[#8ba26f]">
            <MonitorSmartphone className="h-6 w-6" />
          </div>
          <h1
            className="text-2xl font-bold tracking-wide text-white"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            Ciné<span className="font-light text-[#6b7c5c]">Kin</span>
          </h1>
          <p className="mt-1 text-sm text-white/50">Espace client</p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-5 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6"
        >
          <div className="space-y-2">
            <Label htmlFor="c-mac" className="text-white/70">
              Adresse MAC
            </Label>
            <input
              id="c-mac"
              value={mac}
              onChange={e => setMac(formatMacInput(e.target.value))}
              placeholder="00:11:22:33:44:55"
              inputMode="text"
              autoCapitalize="characters"
              className="h-11 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-center font-mono text-lg tracking-widest text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#6b7c5c]"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="c-pin" className="text-white/70">
              Code PIN (6 chiffres)
            </Label>
            <input
              id="c-pin"
              value={pin}
              onChange={e =>
                setPin(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="••••••"
              className="h-11 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-center font-mono text-2xl tracking-[0.5em] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#6b7c5c]"
            />
          </div>

          <Button
            type="submit"
            disabled={login.isPending || !macComplete || !pinComplete}
            className="w-full bg-[#5a6b4e] text-white hover:bg-[#4d5d42]"
          >
            {login.isPending ? "Connexion…" : "Se connecter"}
          </Button>
        </form>
      </div>
    </div>
  );
}

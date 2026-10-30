import { useState } from "react";
import { Copy, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useToast } from "@/components/Toast";
import { SectionCard, LicenseSelect } from "@/components/admin/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  computeStatus,
  statusMeta,
  licenseLabel,
  formatDate,
  type LicenseType,
} from "@/lib/licenseFormat";

type ClientRow = {
  id: number;
  mac: string;
  name: string | null;
  email: string | null;
  licenseType: LicenseType;
  expiresAt: Date | string | null;
  trialEndsAt: Date | string | null;
  createdAt: Date | string;
  isRegistered: boolean;
  claimCodePending: boolean;
};

export default function ClientsSection() {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const clients = trpc.admin.appClientList.useQuery();

  const [renewTarget, setRenewTarget] = useState<ClientRow | null>(null);
  const [renewType, setRenewType] = useState<"12_months" | "unlimited">(
    "12_months"
  );
  const [claimCredential, setClaimCredential] = useState<{
    code: string;
    expiresAt: Date | string;
  } | null>(null);

  const renew = trpc.admin.appClientRenew.useMutation({
    onSuccess: data => {
      toast("Licence renouvelée.", "success");
      if (data.claimCode && data.claimCodeExpiresAt) {
        setClaimCredential({
          code: data.claimCode,
          expiresAt: data.claimCodeExpiresAt,
        });
      }
      setRenewTarget(null);
      utils.admin.appClientList.invalidate();
      utils.admin.activationList.invalidate();
    },
    onError: e => toast(e.message || "Échec du renouvellement", "error"),
  });

  const issueClaimCode = trpc.admin.appClientIssueClaimCode.useMutation({
    onSuccess: data => {
      setClaimCredential({
        code: data.claimCode,
        expiresAt: data.claimCodeExpiresAt,
      });
      utils.admin.appClientList.invalidate();
      toast("Nouveau code d'activation généré.", "success");
    },
    onError: e => toast(e.message || "Impossible de générer le code", "error"),
  });

  const openRenew = (c: ClientRow) => {
    setRenewType(c.licenseType === "unlimited" ? "unlimited" : "12_months");
    setRenewTarget(c);
  };

  return (
    <>
      <SectionCard title="Clients application">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>E-mail</TableHead>
                <TableHead>Formule active</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Client depuis</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.data && clients.data.length > 0 ? (
                clients.data.map(c => {
                  const meta = statusMeta(computeStatus(c), c.trialEndsAt);
                  const permanent =
                    c.licenseType === "unlimited" && meta.label === "Active";
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium text-foreground">
                        {c.name || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.email || "—"}
                      </TableCell>
                      <TableCell>{licenseLabel(c.licenseType)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={meta.className}>
                          {meta.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(c.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {!c.isRegistered && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={issueClaimCode.isPending}
                              onClick={() =>
                                issueClaimCode.mutate({ appClientId: c.id })
                              }
                            >
                              <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                              {c.claimCodePending
                                ? "Régénérer le code"
                                : "Générer le code"}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={permanent}
                            onClick={() => openRenew(c)}
                            className="border-[#5a6b4e]/40 text-[#8ba26f] hover:bg-[#5a6b4e]/10 hover:text-[#8ba26f]"
                          >
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            {permanent ? "Licence définitive" : "Renouveler"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-12 text-center text-muted-foreground"
                  >
                    {clients.isLoading ? "Chargement…" : "Aucun client"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <Dialog
        open={!!renewTarget}
        onOpenChange={open => !open && setRenewTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renouveler la licence</DialogTitle>
            <DialogDescription>
              {renewTarget?.name || renewTarget?.email || renewTarget?.mac} — si
              la licence est encore active, la nouvelle période commencera après
              l'échéance existante.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Type de licence
            </label>
            <LicenseSelect
              value={renewType}
              onChange={e =>
                setRenewType(e.target.value as "12_months" | "unlimited")
              }
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenewTarget(null)}>
              Annuler
            </Button>
            <Button
              disabled={renew.isPending}
              onClick={() =>
                renewTarget &&
                renew.mutate({
                  appClientId: renewTarget.id,
                  licenseType: renewType,
                })
              }
              className="bg-[#5a6b4e] text-white hover:bg-[#4d5d42]"
            >
              {renew.isPending ? "Renouvellement…" : "Renouveler la licence"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!claimCredential}
        onOpenChange={open => !open && setClaimCredential(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
              Code d'activation à usage unique
            </DialogTitle>
            <DialogDescription>
              Transmettez ce code au client. Il expire le{" "}
              {claimCredential ? formatDate(claimCredential.expiresAt) : "—"}
              et son texte ne sera pas conservé par le serveur.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-3">
            <code className="flex-1 font-mono text-lg font-semibold tracking-wider text-foreground">
              {claimCredential?.code}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (claimCredential)
                  navigator.clipboard?.writeText(claimCredential.code);
                toast("Code copié.", "success");
              }}
            >
              <Copy className="mr-1.5 h-4 w-4" />
              Copier
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setClaimCredential(null)}>
              J'ai copié, fermer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

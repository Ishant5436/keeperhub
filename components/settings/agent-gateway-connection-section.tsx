"use client";

import { Check, Copy, Key, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

type AgentGatewayConnectionSectionProps = {
  config: Record<string, unknown>;
  updateConfig: (key: string, value: string) => void;
  isEditMode?: boolean;
};

type ProvisionResponse = {
  subOrgId: string;
  walletAddress: string;
  hmacSecret: string;
};

export function AgentGatewayConnectionSection({
  config,
  updateConfig,
  isEditMode = false,
}: AgentGatewayConnectionSectionProps) {
  const [provisioning, setProvisioning] = useState(false);
  const [provisionedAddress, setProvisionedAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(Boolean(config.subOrgId || config.hmacSecret));

  const subOrgId = (config.subOrgId as string) || "";
  const hmacSecret = (config.hmacSecret as string) || "";
  const isConfigured = Boolean(subOrgId && hmacSecret);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      toast.success(`${label} copied to clipboard`);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleProvision = async () => {
    setProvisioning(true);
    try {
      const response = await fetch("/api/agentic-wallet/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const data = (await response.json()) as ProvisionResponse & { error?: string };

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("Provisioning rate limit reached (5/hour). Please wait or enter existing credentials.");
        }
        throw new Error(data.error || `Provisioning failed with HTTP ${response.status}`);
      }

      if (!data.subOrgId || !data.hmacSecret) {
        throw new Error("Invalid response from provisioning endpoint");
      }

      updateConfig("subOrgId", data.subOrgId);
      updateConfig("hmacSecret", data.hmacSecret);
      if (data.walletAddress) {
        setProvisionedAddress(data.walletAddress);
      }

      toast.success("Agent wallet provisioned successfully!");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to provision agent wallet";
      toast.error(message);
    } finally {
      setProvisioning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium text-sm">Agent Gateway Credentials</h3>
        <p className="text-muted-foreground text-xs">
          Provision a Turnkey-backed sub-organization or connect an existing agentic wallet.
        </p>
      </div>

      {!isConfigured && !isEditMode && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-center">
          <Sparkles className="mx-auto mb-2 size-6 text-primary" />
          <p className="mb-1 font-medium text-sm">One-Click Agent Wallet Provisioning</p>
          <p className="mb-3 text-muted-foreground text-xs">
            Creates a dedicated, KMS-secured Turnkey sub-org and HMAC credentials automatically.
          </p>
          <Button
            className="w-full sm:w-auto"
            disabled={provisioning}
            onClick={handleProvision}
            type="button"
          >
            {provisioning ? (
              <>
                <Spinner className="mr-2 size-4" />
                Provisioning Wallet...
              </>
            ) : (
              <>
                <Key className="mr-2 size-4" />
                Provision Agent Wallet
              </>
            )}
          </Button>
        </div>
      )}

      {provisionedAddress && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Provisioned Wallet Address:</span>
            <button
              className="flex items-center gap-1 font-mono hover:text-foreground"
              onClick={() => copyToClipboard(provisionedAddress, "Wallet Address")}
              type="button"
            >
              {copied === "Wallet Address" ? <Check className="size-3" /> : <Copy className="size-3" />}
              {provisionedAddress.slice(0, 8)}...{provisionedAddress.slice(-6)}
            </button>
          </div>
        </div>
      )}

      {isConfigured && (
        <div className="rounded-md border bg-muted/40 p-3 text-xs">
          <div className="flex items-center justify-between pb-1">
            <span className="font-medium text-foreground">Configured Sub-Org:</span>
            <button
              className="flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground"
              onClick={() => copyToClipboard(subOrgId, "Sub-Org ID")}
              type="button"
            >
              {copied === "Sub-Org ID" ? <Check className="size-3" /> : <Copy className="size-3" />}
              {subOrgId}
            </button>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>HMAC Secret:</span>
            <span className="font-mono">••••••••••••••••</span>
          </div>
        </div>
      )}

      <div className="pt-1">
        <button
          className="text-muted-foreground text-xs underline hover:text-foreground"
          onClick={() => setShowManual((prev) => !prev)}
          type="button"
        >
          {showManual ? "Hide manual credentials" : "Enter credentials manually"}
        </button>
      </div>

      {showManual && (
        <div className="space-y-3 pt-2">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="subOrgId">
              Sub-Org ID
            </Label>
            <Input
              id="subOrgId"
              onChange={(e) => updateConfig("subOrgId", e.target.value.trim())}
              placeholder="e.g. su-..."
              value={subOrgId}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs" htmlFor="hmacSecret">
              HMAC Secret
            </Label>
            <Input
              id="hmacSecret"
              onChange={(e) => updateConfig("hmacSecret", e.target.value.trim())}
              placeholder="Enter HMAC Secret"
              type="password"
              value={hmacSecret}
            />
            <p className="text-muted-foreground text-xs">
              HMAC secret generated during provisioning. Never re-displayed by the server.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

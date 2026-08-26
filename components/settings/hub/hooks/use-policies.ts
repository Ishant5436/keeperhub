"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { PolicyDocument, PolicyEnforcementMode } from "@/lib/policy";
import { useSettingsContext } from "../settings-context";
import { useCachedSection } from "./use-cached-section";

export type PolicyCoverageSummary = {
  score: number;
  perCapability: {
    capability: string;
    bound: string[];
    unbound: string[];
    score: number;
  }[];
};

export type OrganizationPolicySummary = {
  /** Null when the stored document no longer compiles. */
  coverage: PolicyCoverageSummary | null;
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  enforcement: PolicyEnforcementMode;
  version: number;
  changeDelayHours: number;
  effectiveAt: string;
  protected: boolean;
  document: PolicyDocument;
  createdAt: string;
  updatedAt: string;
};

export type PolicyViolation = { sid?: string; message: string };

export type PoliciesState = {
  policies: OrganizationPolicySummary[];
  loading: boolean;
  saving: boolean;
  /** Compile errors from the last attempted save, for display beside the editor. */
  violations: PolicyViolation[];
  /** Legal but probably unintended, e.g. a claimed scope nothing allows. */
  warnings: string[];
  create: (document: PolicyDocument) => Promise<boolean>;
  update: (
    id: string,
    patch: {
      enabled?: boolean;
      enforcement?: PolicyEnforcementMode;
      document?: PolicyDocument;
    }
  ) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  clearFeedback: () => void;
};

function policiesKey(organizationId: string | null): string | null {
  return organizationId ? `policies:${organizationId}` : null;
}

export function usePolicies(): PoliciesState {
  const { organizationId } = useSettingsContext();
  const [saving, setSaving] = useState(false);
  const [violations, setViolations] = useState<PolicyViolation[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const section = useCachedSection<OrganizationPolicySummary[]>(
    policiesKey(organizationId),
    async () => {
      const res = await fetch(`/api/organizations/${organizationId}/policies`);
      if (!res.ok) {
        // A 403 here is the common case: the viewer is a member rather than an
        // admin. An empty list reads correctly for them.
        return [];
      }
      const body = (await res.json()) as {
        policies: OrganizationPolicySummary[];
      };
      return body.policies;
    }
  );

  const clearFeedback = useCallback(() => {
    setViolations([]);
    setWarnings([]);
  }, []);

  const handleResponse = useCallback(
    async (res: Response, successMessage: string): Promise<boolean> => {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        violations?: PolicyViolation[];
        warnings?: string[];
      };
      if (res.ok) {
        setViolations([]);
        setWarnings(body.warnings ?? []);
        toast.success(successMessage);
        return true;
      }
      setViolations(body.violations ?? []);
      toast.error(body.error ?? "Could not save the policy");
      return false;
    },
    []
  );

  const create = useCallback(
    async (document: PolicyDocument): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(
          `/api/organizations/${organizationId}/policies`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ document }),
          }
        );
        const ok = await handleResponse(res, "Policy created in monitor mode");
        if (ok) {
          await section.refetch();
        }
        return ok;
      } catch {
        toast.error("Could not save the policy");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [organizationId, handleResponse, section]
  );

  const update = useCallback(
    async (
      id: string,
      patch: {
        enabled?: boolean;
        enforcement?: PolicyEnforcementMode;
        document?: PolicyDocument;
      }
    ): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(
          `/api/organizations/${organizationId}/policies/${id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }
        );
        const ok = await handleResponse(res, "Policy saved");
        if (ok) {
          await section.refetch();
        }
        return ok;
      } catch {
        toast.error("Could not save the policy");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [organizationId, handleResponse, section]
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await fetch(
          `/api/organizations/${organizationId}/policies/${id}`,
          { method: "DELETE" }
        );
        if (res.ok) {
          await section.refetch();
          toast.success("Policy removed");
          return true;
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(body.error ?? "Could not remove the policy");
        return false;
      } catch {
        toast.error("Could not remove the policy");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [organizationId, section]
  );

  return {
    policies: section.data ?? [],
    loading: section.loading,
    saving,
    violations,
    warnings,
    create,
    update,
    remove,
    clearFeedback,
  };
}

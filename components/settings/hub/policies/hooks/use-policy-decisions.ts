"use client";

import { useCallback, useEffect, useState } from "react";
import { useSettingsContext } from "../../settings-context";

export type Decision = {
  id: string;
  checkpoint: string;
  capability: string;
  resource: string | null;
  outcome: string;
  reason: string;
  matchedSids: string[] | null;
  observedOnly: boolean;
  workflowId: string | null;
  createdAt: string;
};

/** How many recent decisions to show. */
const PAGE_SIZE = 25;

export type PolicyDecisionsState = {
  decisions: Decision[] | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

/**
 * The decisions a policy has already made.
 *
 * Only governed actions appear: an organization with no policy writes no rows,
 * which is why an empty list reads as "nothing is governed yet" rather than as
 * a failure to load.
 */
export function usePolicyDecisions(): PolicyDecisionsState {
  const { organizationId } = useSettingsContext();
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/organizations/${organizationId}/policy-decisions?limit=${PAGE_SIZE}`
      );
      if (!res.ok) {
        setDecisions([]);
        return;
      }
      const body = (await res.json()) as { decisions?: Decision[] };
      setDecisions(body.decisions ?? []);
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return { decisions, loading, refresh };
}

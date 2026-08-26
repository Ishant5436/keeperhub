"use client";

import { useCallback, useState } from "react";
import type { PolicyDocument } from "@/lib/policy";
import { useSettingsContext } from "../../settings-context";

export type ReplayChange = {
  decisionId: string;
  createdAt: string;
  capability: string;
  resource: string | null;
  workflowId: string | null;
  before: string;
  after: string;
  afterReason: string;
  matchedSids: string[];
};

export type ReplayResult = {
  windowDays: number;
  evaluated: number;
  changed: number;
  newlyBlocked: number;
  newlyAllowed: number;
  degraded: number;
  changes: ReplayChange[];
};

/** How far back a replay looks, in days. */
const WINDOW_DAYS = 7;

export type PolicyReplayState = {
  result: ReplayResult | null;
  running: boolean;
  error: string | null;
  run: () => Promise<void>;
};

/**
 * Re-decide recorded decisions against a candidate document.
 *
 * Nothing is charged and nothing is saved: the evaluator is pure and the
 * replay path never reaches the budget ledger.
 */
export function usePolicyReplay(document: PolicyDocument): PolicyReplayState {
  const { organizationId } = useSettingsContext();
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!organizationId) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/organizations/${organizationId}/policies/replay`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document, windowDays: WINDOW_DAYS }),
        }
      );
      const body = (await res.json()) as ReplayResult & { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Could not replay decisions");
      }
      setResult(body);
    } catch (err) {
      console.error("[PolicyBuilder] replay failed", err);
      setError(err instanceof Error ? err.message : "Could not replay");
    } finally {
      setRunning(false);
    }
  }, [organizationId, document]);

  return { result, running, error, run };
}

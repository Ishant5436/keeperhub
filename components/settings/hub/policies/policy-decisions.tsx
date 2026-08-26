"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "../section";
import { usePolicyDecisions } from "./hooks/use-policy-decisions";

/**
 * What the policies actually did.
 *
 * Only governed decisions are recorded, so this is the interesting subset
 * rather than a log of everything that ran. In monitor mode it is the whole
 * point: it shows what would have been blocked before anything is.
 */
export function PolicyDecisions(): React.ReactElement {
  const { decisions, loading, refresh } = usePolicyDecisions();

  return (
    <SettingsCard
      action={
        <Button
          disabled={loading}
          onClick={() => refresh()}
          size="sm"
          variant="ghost"
        >
          Refresh
        </Button>
      }
      description="Only actions a policy governs appear here. In monitor mode these are the actions that would have been blocked."
      title="Recent decisions"
    >
      {decisions === null && (
        <p className="text-muted-foreground text-sm">Loading...</p>
      )}
      {decisions?.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Nothing yet. Decisions appear once a policy governs an action.
        </p>
      )}
      {decisions && decisions.length > 0 && (
        <div className="flex flex-col gap-2">
          {decisions.map((decision) => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5"
              key={decision.id}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      decision.outcome === "deny" ? "destructive" : "secondary"
                    }
                  >
                    {decision.outcome}
                  </Badge>
                  <span className="font-mono text-xs">
                    {decision.capability}
                  </span>
                  {decision.observedOnly && (
                    <Badge variant="outline">Monitor only</Badge>
                  )}
                </div>
                <span className="truncate text-muted-foreground text-xs">
                  {decision.reason}
                  {decision.matchedSids?.length
                    ? ` (${decision.matchedSids.join(", ")})`
                    : ""}
                </span>
              </div>
              <span className="text-muted-foreground text-xs">
                {new Date(decision.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  );
}

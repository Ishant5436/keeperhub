"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PolicyDocument } from "@/lib/policy";
import { usePolicyReplay } from "../hooks/use-policy-replay";

/** How many changed decisions to list before summarising the rest. */
const LISTED = 20;

/**
 * What this document would have done to real traffic.
 *
 * This is the closest thing to proof that a policy is right before it is
 * enforced: a rule that changes nothing over a week of real decisions is
 * either redundant or aimed at the wrong thing, and a rule that blocks
 * everything is visible here rather than in an incident.
 */
export function ReplayPanel({
  document,
}: {
  document: PolicyDocument;
}): React.ReactElement {
  const { result, running, error, run } = usePolicyReplay(document);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-sm">
            Try this policy against what already happened
          </p>
          <p className="text-muted-foreground text-xs">
            Takes the decisions this organization already made over the last
            week and asks each one again, using the policy as it stands here.
            Anything that would come out differently is listed below, so you can
            see what turning this on would do before it does it. Nothing is
            saved and no budget is charged.
          </p>
        </div>
        <Button disabled={running} onClick={run} size="sm" variant="outline">
          {running ? "Checking..." : "Check against history"}
        </Button>
      </div>

      {error && (
        <Alert className="border-destructive/40 bg-destructive/5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {result.evaluated} decisions in {result.windowDays} days
            </Badge>
            <Badge
              variant={result.newlyBlocked > 0 ? "destructive" : "outline"}
            >
              {result.newlyBlocked} newly blocked
            </Badge>
            <Badge variant="outline">{result.newlyAllowed} newly allowed</Badge>
          </div>

          {result.evaluated === 0 && (
            <p className="text-muted-foreground text-xs">
              Nothing to compare against yet. Decisions are recorded when a
              policy governs an action, so this fills up once a policy is saved
              and a workflow runs. On a new organization it stays empty until
              then, which is expected rather than a failure.
            </p>
          )}

          {result.changed === 0 && result.evaluated > 0 && (
            <p className="text-muted-foreground text-xs">
              This document decides every recorded action the same way the
              current policies did. It changes nothing.
            </p>
          )}

          {result.degraded > 0 && (
            <Alert>
              <AlertDescription>
                {result.degraded} of these decisions were recorded before the
                log kept every fact this policy reads, so they were re-decided
                fail-closed. Treat the counts above as a floor for those rows.
                Decisions recorded from now on carry the full detail.
              </AlertDescription>
            </Alert>
          )}

          {result.changes.length > 0 && (
            <ul className="flex flex-col divide-y divide-border">
              {result.changes.slice(0, LISTED).map((change) => (
                <li className="py-2" key={change.decisionId}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{change.before}</Badge>
                    <span className="text-muted-foreground text-xs">to</span>
                    <Badge
                      variant={
                        change.after === "allow" ? "secondary" : "destructive"
                      }
                    >
                      {change.after}
                    </Badge>
                    <span className="font-mono text-[0.7rem] text-muted-foreground">
                      {change.capability}
                    </span>
                  </div>
                  {change.matchedSids.length > 0 && (
                    <p className="text-[0.7rem] text-muted-foreground">
                      Decided by {change.matchedSids.join(", ")}
                    </p>
                  )}
                  {change.resource && (
                    <p className="truncate font-mono text-[0.7rem] text-muted-foreground">
                      {change.resource}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {result.changes.length > LISTED && (
            <p className="text-muted-foreground text-xs">
              {result.changes.length - LISTED} further changed decisions are not
              listed.
            </p>
          )}
        </>
      )}
    </div>
  );
}

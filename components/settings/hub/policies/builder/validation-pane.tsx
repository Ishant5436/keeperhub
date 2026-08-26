"use client";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type CompatibilityFinding,
  CompatibilitySeverity,
} from "@/lib/policy/catalog";
import type { PolicyViolation } from "../../hooks/use-policies";

export type ValidationEntry = {
  key: string;
  location: string | null;
  message: string;
};

function toEntries(
  findings: readonly CompatibilityFinding[],
  severity: CompatibilitySeverity
): ValidationEntry[] {
  return findings
    .filter((finding) => finding.severity === severity)
    .map((finding) => ({
      key: `${finding.sid}-${finding.code}-${finding.subject ?? ""}`,
      location: `${finding.sid} / ${finding.field}`,
      message: finding.message,
    }));
}

function EntryList({
  entries,
  empty,
}: {
  entries: ValidationEntry[];
  empty: string;
}): React.ReactElement {
  if (entries.length === 0) {
    return <p className="py-3 text-muted-foreground text-xs">{empty}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {entries.map((entry) => (
        <li className="py-2" key={entry.key}>
          {entry.location && (
            <p className="font-mono text-[0.7rem] text-muted-foreground">
              {entry.location}
            </p>
          )}
          <p className="text-xs">{entry.message}</p>
        </li>
      ))}
    </ul>
  );
}

function CountedTab({
  value,
  label,
  count,
}: {
  value: string;
  label: string;
  count: number;
}): React.ReactElement {
  return (
    <TabsTrigger value={value}>
      {label}
      {count > 0 && (
        <Badge className="ml-1.5" variant="secondary">
          {count}
        </Badge>
      )}
    </TabsTrigger>
  );
}

/**
 * Everything known about the document, split by what it means.
 *
 * Counts live in the tab labels so a problem is visible without opening the
 * tab that holds it. Errors block a save; the other three do not, because a
 * rule that is merely unusual is still the author's to make.
 */
export function ValidationPane({
  findings,
  violations,
  warnings,
}: {
  findings: readonly CompatibilityFinding[];
  violations: readonly PolicyViolation[];
  warnings: readonly string[];
}): React.ReactElement {
  const errors: ValidationEntry[] = [
    ...toEntries(findings, CompatibilitySeverity.ERROR),
    ...violations.map((violation, index) => ({
      key: `violation-${index}-${violation.message}`,
      location: violation.sid ?? null,
      message: violation.message,
    })),
  ];
  const warningEntries: ValidationEntry[] = [
    ...toEntries(findings, CompatibilitySeverity.WARNING),
    ...warnings.map((warning, index) => ({
      key: `warning-${index}`,
      location: null,
      message: warning,
    })),
  ];
  const security = toEntries(findings, CompatibilitySeverity.SECURITY);

  return (
    <Tabs defaultValue={errors.length > 0 ? "errors" : "security"}>
      <TabsList>
        <CountedTab count={security.length} label="Security" value="security" />
        <CountedTab count={errors.length} label="Errors" value="errors" />
        <CountedTab
          count={warningEntries.length}
          label="Warnings"
          value="warnings"
        />
      </TabsList>

      <TabsContent value="security">
        <EntryList
          empty="Nothing here grants more than it appears to."
          entries={security}
        />
      </TabsContent>
      <TabsContent value="errors">
        <EntryList
          empty="No statement is empty or unsatisfiable."
          entries={errors}
        />
      </TabsContent>
      <TabsContent value="warnings">
        <EntryList
          empty="Every condition and limit binds on something."
          entries={warningEntries}
        />
      </TabsContent>
    </Tabs>
  );
}

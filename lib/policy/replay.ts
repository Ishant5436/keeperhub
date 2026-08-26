import "server-only";

import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { policyDecisions } from "@/lib/db/schema";
import type { Capability } from "@/lib/policy/capabilities";
import { compilePolicy } from "@/lib/policy/compile";
import {
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  type PolicyDecisionReason,
  PolicyOutcome,
  PrincipalKind,
} from "@/lib/policy/constants";
import { evaluatePolicy } from "@/lib/policy/engine";
import type {
  AssetFact,
  CompiledPolicySet,
  CounterpartyFact,
  Fact,
  PolicyDocument,
  PolicyFacts,
  PolicyRequest,
} from "@/lib/policy/types";

/**
 * Markers the decision log writes in place of a value it cannot represent.
 *
 * `[object]` is the legacy form, written before the log retained assets and
 * counterparties structurally. Rows carrying either marker cannot be faithfully
 * re-decided, so replay treats the fact as unknown, which fails closed, and
 * counts the row as degraded rather than pretending to have re-decided it.
 */
const LEGACY_REDACTED = "[object]";
const UNSUMMARISED = "[unsummarised]";

const REDACTION_MARKERS: readonly string[] = [LEGACY_REDACTED, UNSUMMARISED];

const MAX_REPLAY_ROWS = 2000;

/** Identifies the unsaved document in a decision produced by replay. */
const CANDIDATE_POLICY_ID = "candidate";

export type ReplayChange = {
  decisionId: string;
  createdAt: string;
  capability: string;
  resource: string | null;
  workflowId: string | null;
  before: PolicyOutcome;
  after: PolicyOutcome;
  afterReason: PolicyDecisionReason;
  matchedSids: readonly string[];
};

export type ReplayResult = {
  windowDays: number;
  evaluated: number;
  changed: number;
  /** Previously permitted, refused under the candidate policy. */
  newlyBlocked: number;
  /** Previously refused, permitted under the candidate policy. */
  newlyAllowed: number;
  /**
   * Decisions replayed with at least one fact the log could not retain. Their
   * verdicts are fail-closed guesses, so a non-zero count means the numbers
   * above are a floor rather than an answer.
   */
  degraded: number;
  changes: readonly ReplayChange[];
};

function scalarFact(value: unknown): Fact<never> | null {
  if (value === FactState.ABSENT) {
    return { state: FactState.ABSENT };
  }
  if (
    value === FactState.UNKNOWN ||
    (typeof value === "string" && REDACTION_MARKERS.includes(value))
  ) {
    return { state: FactState.UNKNOWN, reason: "not retained in the log" };
  }
  return null;
}

/**
 * Rebuild one fact from its stored summary.
 *
 * Everything replayed is treated as authoritative, because it already passed
 * the provenance rule when the original decision was made. Replay re-asks the
 * policy question, not the provenance question.
 */
function toFact<T>(value: unknown): Fact<T> {
  if (value === undefined || value === null) {
    return { state: FactState.ABSENT };
  }
  const special = scalarFact(value);
  if (special) {
    return special as Fact<T>;
  }
  return {
    state: FactState.KNOWN,
    value: value as T,
    provenance: FactProvenance.AUTHORITATIVE,
  };
}

function wasDegraded(stored: Record<string, unknown>): boolean {
  return Object.values(stored).some(
    (value) => typeof value === "string" && REDACTION_MARKERS.includes(value)
  );
}

function rebuildFacts(
  capability: Capability,
  stored: Record<string, unknown>
): PolicyFacts {
  return {
    capability,
    resource: toFact<string>(stored.resource),
    chainId: toFact<number>(stored.chainId),
    contractAddress: toFact<string>(stored.contractAddress),
    selector: toFact<string>(stored.selector),
    protocolSlug: toFact<string>(stored.protocolSlug),
    assets: toFact<readonly AssetFact[]>(stored.assets),
    counterparties: toFact<readonly CounterpartyFact[]>(stored.counterparties),
    nativeValueWei: toFact<string>(stored.nativeValueWei),
    usdValue: toFact<string>(stored.usdValue),
    unbounded: toFact<boolean>(stored.unbounded),
    gasPriceGwei: toFact<string>(stored.gasPriceGwei),
    gasLimit: toFact<string>(stored.gasLimit),
    signerMode: toFact<string>(stored.signerMode),
    triggerType: toFact<string>(stored.triggerType),
    workflowId: toFact<string>(stored.workflowId),
    workflowTags: toFact<readonly string[]>(stored.workflowTags),
    projectId: toFact<string>(stored.projectId),
    sourceIp: toFact<string>(stored.sourceIp),
    httpHost: toFact<string>(stored.httpHost),
    httpUrl: toFact<string>(stored.httpUrl),
    httpMethod: toFact<string>(stored.httpMethod),
    resourceId: toFact<string>(stored.resourceId),
  };
}

/** Outcomes that let an action proceed. */
function permitted(outcome: PolicyOutcome): boolean {
  return outcome === PolicyOutcome.ALLOW || outcome === PolicyOutcome.UNMANAGED;
}

export type ReplayInput = {
  organizationId: string;
  /** The candidate document, which need not be saved. */
  document: PolicyDocument;
  windowDays: number;
};

/**
 * Re-decide recorded decisions against a candidate policy.
 *
 * Nothing is charged and nothing is written. The evaluator is pure and the
 * ledger is never touched, so replaying a thousand decisions cannot consume a
 * thousand reservations, which is the trap a naive implementation falls into
 * the first time someone opens this on a policy with a daily cap.
 *
 * The window is bounded by what the decision log still retains. A decision
 * older than retention cannot be replayed, so this answers "what would have
 * changed recently", never "what would have changed ever".
 */
export async function replayDecisions(
  input: ReplayInput
): Promise<ReplayResult> {
  const outcome = compilePolicy({
    id: CANDIDATE_POLICY_ID,
    enabled: true,
    document: input.document,
    enforcement: input.document.enforcement,
  });

  if (!outcome.ok) {
    throw new Error(
      `The candidate policy does not compile: ${outcome.errors[0]?.message ?? "unknown error"}`
    );
  }

  const policySet: CompiledPolicySet = {
    organizationId: input.organizationId,
    version: CANDIDATE_POLICY_ID,
    policies: [outcome.compiled],
    compiledAt: Date.now(),
  };

  const since = new Date(Date.now() - input.windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(policyDecisions)
    .where(
      and(
        eq(policyDecisions.organizationId, input.organizationId),
        gte(policyDecisions.createdAt, since)
      )
    )
    .orderBy(desc(policyDecisions.createdAt))
    .limit(MAX_REPLAY_ROWS);

  const changes: ReplayChange[] = [];
  let degraded = 0;
  let newlyBlocked = 0;
  let newlyAllowed = 0;

  for (const row of rows) {
    const stored = row.facts ?? {};
    if (wasDegraded(stored)) {
      degraded += 1;
    }

    const request: PolicyRequest = {
      // The recorded principal kind is not reconstructable into the full
      // discriminated shape, and conditions on the actor are re-read from the
      // stored facts anyway, so replay runs as the service principal.
      principal: {
        kind: PrincipalKind.SERVICE,
        service: "policy-replay",
      },
      organizationId: input.organizationId,
      capability: row.capability,
      facts: rebuildFacts(row.capability, stored),
      checkpoint: (row.checkpoint as PolicyCheckpoint) ?? PolicyCheckpoint.NODE,
      executionId: row.executionId ?? undefined,
      nodeId: row.nodeId ?? undefined,
      workflowId: row.workflowId ?? undefined,
    };

    const decision = evaluatePolicy(request, policySet);
    if (decision.outcome === row.outcome) {
      continue;
    }

    const before = row.outcome;
    const after = decision.outcome;
    if (permitted(before) && !permitted(after)) {
      newlyBlocked += 1;
    }
    if (!permitted(before) && permitted(after)) {
      newlyAllowed += 1;
    }

    changes.push({
      decisionId: row.id,
      createdAt: row.createdAt.toISOString(),
      capability: row.capability,
      resource: row.resource,
      workflowId: row.workflowId,
      before,
      after,
      afterReason: decision.reason,
      matchedSids: decision.matched?.map((m) => m.sid) ?? [],
    });
  }

  return {
    windowDays: input.windowDays,
    evaluated: rows.length,
    changed: changes.length,
    newlyBlocked,
    newlyAllowed,
    degraded,
    changes,
  };
}

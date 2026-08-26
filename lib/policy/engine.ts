/**
 * The evaluator: a pure function from (request, compiled policy set) to one
 * decision.
 *
 * No I/O. Loading policy, resolving grants and computing signals all happen
 * outside, so a decision is replayable from a stored fact bundle and testable
 * without a database.
 *
 * Total by construction: every input produces a decision, and any internal
 * failure produces a denial rather than a throw. A caller can never mistake an
 * engine fault for permission.
 */

import { arnStringMatches } from "./arn";
import { clockFacts } from "./clock-facts";
import {
  FactProvenance,
  FactState,
  isSignalConditionKey,
  PolicyDecisionReason,
  PolicyEffect,
  type PolicyEnforcementMode,
  PolicyOperator,
  PolicyOutcome,
} from "./constants";
import { makeDecision, resolveObservedOnly } from "./evaluator";
import { readListFact } from "./fact-resolution";
import { principalFacts } from "./principal-facts";
import type {
  CompiledPolicy,
  CompiledPolicySet,
  CompiledStatement,
  Fact,
  MatchedStatement,
  PolicyCondition,
  PolicyConditionOperand,
  PolicyDecision,
  PolicyFacts,
  PolicyRequest,
  PolicySignalBundle,
  Principal,
} from "./types";

/**
 * Three-valued match. UNKNOWN is not a third boolean for convenience: it is
 * what makes the fail-closed rule expressible, because an allow and a deny
 * must resolve an undeterminable condition in opposite directions.
 */
const Match = {
  YES: "yes",
  NO: "no",
  UNKNOWN: "unknown",
} as const;

type Match = (typeof Match)[keyof typeof Match];

function factValue<T>(fact: Fact<T> | undefined): {
  state: FactState;
  value?: T;
  provenance?: FactProvenance;
} {
  if (!fact) {
    return { state: FactState.ABSENT };
  }
  if (fact.state === FactState.KNOWN) {
    return {
      state: FactState.KNOWN,
      value: fact.value,
      provenance: fact.provenance,
    };
  }
  return { state: fact.state };
}

function compareNumeric(
  op: PolicyOperator,
  left: string,
  right: PolicyConditionOperand
): Match {
  const a = Number(left);
  const b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return Match.UNKNOWN;
  }
  switch (op) {
    case PolicyOperator.LT:
      return a < b ? Match.YES : Match.NO;
    case PolicyOperator.LTE:
      return a <= b ? Match.YES : Match.NO;
    case PolicyOperator.GT:
      return a > b ? Match.YES : Match.NO;
    case PolicyOperator.GTE:
      return a >= b ? Match.YES : Match.NO;
    default:
      return Match.UNKNOWN;
  }
}

function compareEquality(
  op: PolicyOperator,
  left: unknown,
  right: PolicyConditionOperand
): Match {
  const equal = String(left) === String(right);
  if (op === PolicyOperator.EQ) {
    return equal ? Match.YES : Match.NO;
  }
  return equal ? Match.NO : Match.YES;
}

function compareMembership(
  op: PolicyOperator,
  left: unknown,
  right: PolicyConditionOperand
): Match {
  if (!Array.isArray(right)) {
    return Match.UNKNOWN;
  }
  const value = String(left);
  // Membership accepts an identifier pattern as well as a literal, so an `in`
  // list holding a wildcard protocol identifier matches the same way a resource
  // pattern does.
  //
  // Deliberately described rather than shown: Tailwind scans source files for
  // class candidates, and a bracketed token whose value contains a slash then
  // two asterisks is read as an arbitrary property. It emits that as a CSS
  // declaration, which opens a comment and silently swallows the rest of the
  // stylesheet, theme tokens included.
  const present = right.some(
    (candidate) => candidate === value || arnStringMatches(candidate, value)
  );
  if (op === PolicyOperator.IN) {
    return present ? Match.YES : Match.NO;
  }
  return present ? Match.NO : Match.YES;
}

function evaluatePredicate(predicate: PolicyCondition, raw: unknown): Match {
  let result: Match = Match.YES;
  const entries = Object.entries(predicate) as [
    PolicyOperator,
    PolicyConditionOperand,
  ][];
  for (const [op, operand] of entries) {
    let one: Match;
    switch (op) {
      case PolicyOperator.LT:
      case PolicyOperator.LTE:
      case PolicyOperator.GT:
      case PolicyOperator.GTE:
        one = compareNumeric(op, String(raw), operand);
        break;
      case PolicyOperator.EQ:
      case PolicyOperator.NEQ:
        one = compareEquality(op, raw, operand);
        break;
      case PolicyOperator.IN:
      case PolicyOperator.NOT_IN:
        one = compareMembership(op, raw, operand);
        break;
      case PolicyOperator.MATCHES:
        one =
          typeof operand === "string" && new RegExp(operand).test(String(raw))
            ? Match.YES
            : Match.NO;
        break;
      default:
        one = Match.UNKNOWN;
    }
    if (one === Match.NO) {
      return Match.NO;
    }
    if (one === Match.UNKNOWN) {
      result = Match.UNKNOWN;
    }
  }
  return result;
}

/**
 * Map a condition key onto the fact it reads.
 *
 * Facts about the actor are derived from the principal rather than looked up on
 * `facts`, so a caller can neither forget to supply them nor supply a different
 * actor from the one the request is being evaluated for.
 */
function readFact(
  facts: PolicyFacts,
  key: string,
  principal?: Principal
): Fact<unknown> | undefined {
  const derived = principalFacts(principal)[key] ?? clockFacts()[key];
  if (derived) {
    return derived;
  }
  const list = readListFact(facts, key);
  if (list) {
    return list;
  }
  return (facts as unknown as Record<string, Fact<unknown>>)[key];
}

function evaluateSignal(
  signals: PolicySignalBundle | undefined,
  key: string,
  predicate: PolicyCondition
): Match {
  const signal = signals?.[key as keyof PolicySignalBundle];
  if (!signal?.available) {
    // An unavailable signal is unknown, never false. A missing risk score must
    // not read as "not risky".
    return Match.UNKNOWN;
  }
  return evaluatePredicate(predicate, signal.value);
}

/**
 * Whether a statement matches. The provenance rule lives here: a fact the
 * workflow itself produced can never make an allow match, so an attacker who
 * controls upstream data cannot talk the engine into permitting something.
 */
function statementMatches(
  statement: CompiledStatement,
  request: PolicyRequest
): Match {
  if (!statement.capabilities.includes(request.capability)) {
    return Match.NO;
  }

  const isAllow = statement.effect === PolicyEffect.ALLOW;
  let result: Match = Match.YES;

  if (statement.resourcePatterns.length > 0) {
    const resource = factValue(request.facts.resource);
    if (resource.state !== FactState.KNOWN || !resource.value) {
      return Match.UNKNOWN;
    }
    if (isAllow && resource.provenance === FactProvenance.WORKFLOW_DERIVED) {
      // Unvouched. The grant layer is what promotes a resolved template to
      // authoritative; without that promotion it cannot ground a grant.
      return Match.UNKNOWN;
    }
    const hit = statement.resourcePatterns.some((p) =>
      arnStringMatches(p, String(resource.value))
    );
    if (!hit) {
      return Match.NO;
    }
  }

  for (const [key, predicate] of Object.entries(statement.condition)) {
    if (!predicate) {
      continue;
    }
    let one: Match;
    if (isSignalConditionKey(key)) {
      one = evaluateSignal(request.signals, key, predicate);
    } else {
      const fact = factValue(readFact(request.facts, key, request.principal));
      if (fact.state !== FactState.KNOWN) {
        one = Match.UNKNOWN;
      } else if (
        isAllow &&
        fact.provenance === FactProvenance.WORKFLOW_DERIVED
      ) {
        one = Match.UNKNOWN;
      } else {
        one = evaluatePredicate(predicate, fact.value);
      }
    }
    if (one === Match.NO) {
      return Match.NO;
    }
    if (one === Match.UNKNOWN) {
      result = Match.UNKNOWN;
    }
  }

  return result;
}

/**
 * Resolve a three-valued match against an effect.
 *
 * An allow needs a definite yes: you cannot grant on something you could not
 * determine. A deny treats unknown as a hit: if it cannot be ruled out, refuse.
 * This asymmetry is the fail-closed rule, and it is the only place it lives.
 */
function matchCounts(match: Match, effect: PolicyEffect): boolean {
  if (match === Match.YES) {
    return true;
  }
  if (match === Match.NO) {
    return false;
  }
  return effect !== PolicyEffect.ALLOW;
}

function governs(policy: CompiledPolicy, request: PolicyRequest): boolean {
  if (policy.managedCapabilities.includes(request.capability)) {
    return true;
  }
  const resource = factValue(request.facts.resource);
  if (resource.state !== FactState.KNOWN || !resource.value) {
    return false;
  }
  return policy.managedResourcePatterns.some((p) =>
    arnStringMatches(p, String(resource.value))
  );
}

export function evaluatePolicy(
  request: PolicyRequest,
  policySet: CompiledPolicySet | null
): PolicyDecision {
  const startedAt = Date.now();

  const governing = (policySet?.policies ?? []).filter((p) =>
    governs(p, request)
  );

  if (governing.length === 0) {
    return makeDecision({
      outcome: PolicyOutcome.UNMANAGED,
      reason: PolicyDecisionReason.UNMANAGED,
      policyVersion: policySet?.version ?? null,
      startedAt,
    });
  }

  const observedOnly = resolveObservedOnly(
    governing.map((p) => p.enforcement as PolicyEnforcementMode)
  );
  const governingPolicyIds = governing.map((p) => p.policyId);
  const base = {
    governingPolicyIds,
    observedOnly,
    policyVersion: policySet?.version ?? null,
    startedAt,
  };

  const matched: Record<PolicyEffect, MatchedStatement[]> = {
    [PolicyEffect.ALLOW]: [],
    [PolicyEffect.DENY]: [],
  };

  for (const policy of governing) {
    for (const statement of policy.statements) {
      if (matchCounts(statementMatches(statement, request), statement.effect)) {
        matched[statement.effect].push({
          policyId: policy.policyId,
          sid: statement.sid,
          effect: statement.effect,
        });
      }
    }
  }

  // Deny overrides everything. It is the only effect that is monotonic under
  // adding a policy, which is why a real ceiling has to be written as one.
  if (matched[PolicyEffect.DENY].length > 0) {
    return makeDecision({
      ...base,
      outcome: PolicyOutcome.DENY,
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      matched: matched[PolicyEffect.DENY],
    });
  }

  if (matched[PolicyEffect.ALLOW].length > 0) {
    return makeDecision({
      ...base,
      outcome: PolicyOutcome.ALLOW,
      reason: PolicyDecisionReason.EXPLICIT_ALLOW,
      matched: matched[PolicyEffect.ALLOW],
    });
  }

  // Managed, and nothing permitted it. This is the allowlist behaviour, and the
  // most common cause of a workflow that stops without an obvious reason.
  return makeDecision({
    ...base,
    outcome: PolicyOutcome.DENY,
    reason: PolicyDecisionReason.NO_MATCHING_ALLOW,
  });
}

/** The evaluator, in the shape the guards consume. */
export const POLICY_ENGINE = {
  evaluate: evaluatePolicy,
};

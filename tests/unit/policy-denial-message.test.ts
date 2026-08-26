import { describe, expect, it } from "vitest";
import { PolicyDecisionReason } from "@/lib/policy";
import {
  explainDenial,
  POLICY_DENIAL_MESSAGE,
  policyPageLink,
} from "@/lib/policy/errors";

const ORG = "85a32c46-a6b5-401c-9d88-598cf573e042";

describe("what a blocked run tells the reader", () => {
  it("says why it was refused", () => {
    expect(
      explainDenial({
        reason: PolicyDecisionReason.LIMIT_EXCEEDED,
        organizationId: ORG,
      })
    ).toContain("no remaining allowance");
  });

  it("links absolutely, so it is clickable outside the app too", () => {
    // A denial is read in an execution log, an email, an agent's reply or a CLI
    // transcript as often as in the app. A path alone works in one of those.
    const message = explainDenial({
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      organizationId: ORG,
    });
    expect(message).toMatch(/https?:\/\/\S+\/settings\/[^/]+\/policies/);
  });

  it("carries the reason and the link, and nothing else", () => {
    // Pinning the whole string is what stops a rule name, a condition or an
    // amount being appended later.
    for (const reason of Object.values(PolicyDecisionReason)) {
      expect(explainDenial({ reason, organizationId: ORG })).toBe(
        `${POLICY_DENIAL_MESSAGE[reason]} Review your organization's policies at ${policyPageLink(
          { organizationId: ORG }
        )}`
      );
    }
  });

  it("never names the rule that decided", () => {
    // Reading policy is limited to admins and owners, and any member can run a
    // workflow. A statement name is author-written and routinely carries the
    // thing it bounds, so naming it would disclose the rule to someone not
    // allowed to read it.
    const message = explainDenial({
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      organizationId: ORG,
    });
    expect(message).not.toContain("Rule:");
    expect(message).not.toContain("sid");
  });

  it("omits the link when the organization is unknown", () => {
    expect(explainDenial({ reason: PolicyDecisionReason.ENGINE_ERROR })).toBe(
      POLICY_DENIAL_MESSAGE[PolicyDecisionReason.ENGINE_ERROR]
    );
  });

  it("points at the policy page without naming one", () => {
    // A bare organization link, so the URL itself reveals nothing either.
    expect(policyPageLink({ organizationId: ORG })).toMatch(
      new RegExp(`/settings/${ORG}/policies$`)
    );
  });
});

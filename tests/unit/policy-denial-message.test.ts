import { describe, expect, it } from "vitest";
import { PolicyDecisionReason } from "@/lib/policy";
import {
  explainDenial,
  POLICY_DENIAL_MESSAGE,
  policyPageLink,
} from "@/lib/policy/errors";

const ORG = "85a32c46-a6b5-401c-9d88-598cf573e042";

describe("what a blocked run tells the reader", () => {
  it("names the rule that refused it", () => {
    // A rule the reader cannot find is one they cannot fix.
    expect(
      explainDenial({
        reason: PolicyDecisionReason.EXPLICIT_DENY,
        sid: "no-borrowing-ever",
        policyId: "pol_9f2",
        organizationId: ORG,
      })
    ).toContain("Rule: no-borrowing-ever");
  });

  it("links absolutely, so it is clickable outside the app too", () => {
    // A denial is read in an execution log, an email, an agent's reply or a CLI
    // transcript as often as in the app. A path alone works in one of those.
    const link = policyPageLink({
      organizationId: ORG,
      policyId: "pol_9f2",
      sid: "cap",
    });
    expect(link).toMatch(/^https?:\/\//);
    expect(link).toContain(`/settings/${ORG}/policies?policy=pol_9f2&rule=cap`);
  });

  it("still links to the page when nothing matched", () => {
    // An implicit deny has no statement to name, and the reader still needs
    // somewhere to go.
    const message = explainDenial({
      reason: PolicyDecisionReason.NO_MATCHING_ALLOW,
      organizationId: ORG,
    });
    expect(message).toMatch(/https?:\/\/\S+\/settings\/[^/]+\/policies/);
    expect(message).not.toContain("Rule:");
  });

  it("says why a limit refused, not merely that something did", () => {
    expect(
      explainDenial({
        reason: PolicyDecisionReason.LIMIT_EXCEEDED,
        organizationId: ORG,
      })
    ).toContain("no remaining allowance");
  });

  it("carries the reason, the rule and the link, and nothing else", () => {
    // The message reaches whoever ran the workflow, who may not be allowed to
    // read the policy that refused them. Pinning the exact shape is what stops
    // a condition or a limit value being added to it later.
    const message = explainDenial({
      reason: PolicyDecisionReason.LIMIT_EXCEEDED,
      sid: "daily-cap",
      policyId: "pol_9f2",
      organizationId: ORG,
    });
    expect(message).toBe(
      `${POLICY_DENIAL_MESSAGE[PolicyDecisionReason.LIMIT_EXCEEDED]} Rule: daily-cap. Review it at ${policyPageLink(
        { organizationId: ORG, policyId: "pol_9f2", sid: "daily-cap" }
      )}`
    );
  });

  it("omits the link when the organization is unknown", () => {
    expect(
      explainDenial({ reason: PolicyDecisionReason.ENGINE_ERROR })
    ).not.toContain("/policies");
  });
});

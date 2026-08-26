import "server-only";

/**
 * The policy check for the direct-execution API.
 *
 * These routes are the paths an agent uses, and they never touch the workflow
 * engine, so the per-node check does not cover them. Without this the most
 * agent-exposed surface in the product would be the one surface policy did not
 * reach.
 *
 * Called immediately before the spending-cap reservation, which is the last
 * gate before a transaction is built.
 */

import { NextResponse } from "next/server";
import { buildAssetArn, buildContractCallArn } from "./arn";
import type { Capability } from "./capabilities";
import { enforcePolicy } from "./guard";
import {
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  PolicyRole,
  PrincipalKind,
} from "./index";
import type { PolicyFacts } from "./types";

const UNKNOWN = { state: FactState.UNKNOWN } as const;

export type DirectExecutionCheck = {
  organizationId: string;
  apiKeyId: string;
  capability: Capability;
  chainId?: number;
  contractAddress?: string;
  tokenAddress?: string;
  selector?: string;
  recipient?: string;
};

function directFacts(check: DirectExecutionCheck): PolicyFacts {
  let resource = UNKNOWN as PolicyFacts["resource"];
  if (check.chainId !== undefined && check.contractAddress) {
    resource = {
      state: FactState.KNOWN,
      value: buildContractCallArn({
        chainId: check.chainId,
        contractAddress: check.contractAddress,
        selector: check.selector ?? null,
      }),
      // The caller named this target directly, so it is the request rather than
      // something a workflow computed about itself.
      provenance: FactProvenance.AUTHORITATIVE,
    };
  } else if (check.chainId !== undefined && check.tokenAddress) {
    resource = {
      state: FactState.KNOWN,
      value: buildAssetArn({
        chainId: check.chainId,
        tokenAddress: check.tokenAddress,
      }),
      provenance: FactProvenance.AUTHORITATIVE,
    };
  }

  return {
    capability: check.capability,
    resource,
    chainId:
      check.chainId === undefined
        ? UNKNOWN
        : {
            state: FactState.KNOWN,
            value: check.chainId,
            provenance: FactProvenance.AUTHORITATIVE,
          },
    contractAddress: check.contractAddress
      ? {
          state: FactState.KNOWN,
          value: check.contractAddress.toLowerCase(),
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    selector: check.selector
      ? {
          state: FactState.KNOWN,
          value: check.selector,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    protocolSlug: UNKNOWN,
    assets: UNKNOWN,
    counterparties: UNKNOWN,
    nativeValueWei: UNKNOWN,
    usdValue: UNKNOWN,
    unbounded: UNKNOWN,
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    // The trigger for a direct call is the API itself, which is worth naming so
    // a rule like "direct execution may not move funds" is expressible.
    triggerType: {
      state: FactState.KNOWN,
      value: "direct",
      provenance: FactProvenance.AUTHORITATIVE,
    },
    workflowId: UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: check.recipient
      ? {
          state: FactState.KNOWN,
          value: check.recipient.toLowerCase(),
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
  };
}

/**
 * Returns a ready 403 when policy refuses, or null to proceed.
 *
 * An API key carries a role, so a key issued at member level cannot reach past
 * what a member could do. That is what stops the agent surface being the widest
 * one in the product.
 */
export async function enforceDirectExecutionPolicy(
  check: DirectExecutionCheck
): Promise<NextResponse | null> {
  const verdict = await enforcePolicy({
    principal: {
      kind: PrincipalKind.API_KEY,
      apiKeyId: check.apiKeyId,
      organizationId: check.organizationId,
      role: PolicyRole.MEMBER,
    },
    organizationId: check.organizationId,
    capability: check.capability,
    facts: directFacts(check),
    checkpoint: PolicyCheckpoint.NODE,
    grantSubject: { kind: "principal", id: check.apiKeyId },
  });

  if (!verdict.blocked) {
    return null;
  }

  return NextResponse.json(
    {
      error: verdict.decision.message ?? "Blocked by an organization policy",
      code: "policy_denied",
      reason: verdict.decision.reason,
      retryable: false,
    },
    { status: 403 }
  );
}

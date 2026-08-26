import "server-only";

import { and, eq, gt } from "drizzle-orm";
import type { ethers } from "ethers";
import { db } from "@/lib/db";
import { policyDecisions } from "@/lib/db/schema";
import { buildContractCallArn } from "@/lib/policy/arn";
import { Capability } from "@/lib/policy/capabilities";
import { resolveCallCapability } from "@/lib/policy/catalog/call-capability";
import {
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  PrincipalKind,
} from "@/lib/policy/constants";
import { PolicyDeniedError } from "@/lib/policy/errors";
import { enforcePolicy } from "@/lib/policy/guard";
import {
  EMPTY_CALLDATA,
  intentDigest,
  selectorOf,
} from "@/lib/policy/intent-digest";
import type { Fact, PolicyFacts } from "@/lib/policy/types";

const UNKNOWN = { state: FactState.UNKNOWN } as const;

function known<T>(value: T): Fact<T> {
  return {
    state: FactState.KNOWN,
    value,
    provenance: FactProvenance.AUTHORITATIVE,
  };
}

export type SigningContext = {
  organizationId: string;
  chainId: number;
};

/**
 * Consume a receipt the node check left for this exact action.
 *
 * A match means policy already permitted this transaction, with the workflow
 * context this layer does not have: who triggered the run, and which rule
 * allowed it. Deciding again here without that context would refuse actions
 * that were legitimately allowed.
 *
 * The receipt is consumed, so it cannot authorise a second transaction.
 */
async function consumeReceipt(
  organizationId: string,
  digest: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: policyDecisions.id })
    .from(policyDecisions)
    .where(
      and(
        eq(policyDecisions.organizationId, organizationId),
        eq(policyDecisions.intentDigest, digest),
        eq(policyDecisions.receiptStatus, "pending"),
        gt(policyDecisions.receiptExpiresAt, new Date())
      )
    )
    .limit(1);

  if (!row) {
    return false;
  }

  await db
    .update(policyDecisions)
    .set({ receiptStatus: "consumed" })
    .where(eq(policyDecisions.id, row.id));
  return true;
}

function signingFacts(input: {
  chainId: number;
  to: string;
  selector: string;
  valueWei: string;
  capability: Capability;
}): PolicyFacts {
  return {
    capability: input.capability,
    resource: known(
      buildContractCallArn({
        chainId: input.chainId,
        contractAddress: input.to,
        selector: input.selector === EMPTY_CALLDATA ? null : input.selector,
      })
    ),
    chainId: known(input.chainId),
    contractAddress: known(input.to.toLowerCase()),
    selector:
      input.selector === EMPTY_CALLDATA ? UNKNOWN : known(input.selector),
    protocolSlug: UNKNOWN,
    // At signing there is no ABI, so the asset and counterparty a call names
    // cannot be decoded. They stay unknown, which makes a deny about them fire
    // and an allow about them not match.
    assets: UNKNOWN,
    counterparties: UNKNOWN,
    nativeValueWei: known(input.valueWei),
    usdValue: UNKNOWN,
    unbounded: UNKNOWN,
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    triggerType: UNKNOWN,
    workflowId: UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: UNKNOWN,
  };
}

/**
 * Check a transaction against policy at the moment it is signed.
 *
 * This is the layer that makes a rule universal. Not every path to a signature
 * goes through the workflow engine: direct execution APIs, agent calls and
 * single-node runs all reach a signer another way, and a check bound to the act
 * of signing catches every one of them, including paths that do not exist yet.
 *
 * It has only the chain, the address and the four-byte selector to work from,
 * which is exactly why identifiers are keyed on selector rather than on a
 * signature that cannot be recovered here.
 */
export async function assertSigningAllowed(
  context: SigningContext,
  tx: { to?: string | null; data?: string | null; value?: bigint | null }
): Promise<void> {
  const to = tx.to;
  if (!to) {
    // A contract deployment has no target to name. Nothing in the identifier
    // grammar addresses it, so there is no rule it could match.
    return;
  }

  const selector = selectorOf(tx.data);
  const valueWei =
    tx.value === null || tx.value === undefined ? "0" : tx.value.toString();
  const digest = intentDigest({
    chainId: context.chainId,
    to,
    selector,
    valueWei,
  });

  if (await consumeReceipt(context.organizationId, digest)) {
    return;
  }

  const baseCapability =
    selector === EMPTY_CALLDATA
      ? Capability.ASSET_TRANSFER_NATIVE
      : Capability.CONTRACT_WRITE;

  const facts = signingFacts({
    chainId: context.chainId,
    to,
    selector,
    valueWei,
    capability: baseCapability,
  });

  // What the function actually does, read from the contract rather than
  // assumed, so a rule about borrowing binds here too.
  const capability = await resolveCallCapability({
    chainId: context.chainId,
    facts,
    fallback: baseCapability,
  });

  const verdict = await enforcePolicy({
    principal: { kind: PrincipalKind.SERVICE, service: "signer" },
    organizationId: context.organizationId,
    capability,
    facts: { ...facts, capability },
    checkpoint: PolicyCheckpoint.SIGNING,
  });

  if (verdict.blocked) {
    throw new PolicyDeniedError({
      reason: verdict.decision.reason,
      sid: verdict.decision.matched[0]?.sid,
      policyId: verdict.decision.matched[0]?.policyId,
      policyVersion: verdict.decision.policyVersion,
    });
  }
}

/**
 * Wrap a signer so nothing it signs escapes policy.
 *
 * A proxy rather than a subclass, because the signer is built by an external
 * SDK and every caller holds it as an `ethers.Signer`. Guarding at the point
 * signers are created is what makes the check unavoidable: a route added
 * tomorrow gets it without knowing policy exists.
 */
export function guardSigner(
  signer: ethers.Signer,
  context: SigningContext
): ethers.Signer {
  return new Proxy(signer, {
    get(target, property, receiver) {
      if (property !== "sendTransaction") {
        return Reflect.get(target, property, receiver);
      }
      return async (tx: {
        to?: string | null;
        data?: string | null;
        value?: bigint | null;
      }) => {
        await assertSigningAllowed(context, tx);
        return await (
          target as unknown as {
            sendTransaction: (request: unknown) => Promise<unknown>;
          }
        ).sendTransaction(tx);
      };
    },
  });
}

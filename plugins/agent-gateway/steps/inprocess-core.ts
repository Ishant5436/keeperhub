/**
 * In-process execution alternative for Agent Gateway.
 *
 * Calls the agentic-wallet signing and credit balance primitives directly
 * in-process instead of routing HTTP requests out to the Cloudflare edge.
 * Bypasses edge WAF challenges and loopback SSRF blocks entirely.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 */
import "server-only";

import { eq, sql } from "drizzle-orm";
import { Challenge } from "mppx";
import {
  createApprovalRequest,
  deriveApprovalBinding,
} from "@/lib/agentic-wallet/approval";
import {
  ALLOWED_TEMPO_CHAIN_IDS,
  TEMPO_MAINNET_CHAIN_ID,
} from "@/lib/agentic-wallet/constants";
import { reserveSpend, rollbackSpend } from "@/lib/agentic-wallet/daily-spend";
import { classifyRisk } from "@/lib/agentic-wallet/risk";
import {
  PolicyBlockedError,
  signMppProof,
  signMppTransaction,
  signX402Challenge,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign";
import { verifyWorkflowBinding } from "@/lib/agentic-wallet/workflow-binding";
import { db } from "@/lib/db";
import { agenticWalletCredits, agenticWallets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { recordAuditEvent } from "@/lib/security/audit-log";
import type { CheckCreditResult } from "./check-credit-core";
import type { SignPaymentCoreInput, SignPaymentResult } from "./sign-payment-core";

/**
 * Reads off-chain credit ledger balance in-process directly from DB.
 */
export async function checkCreditInProcess(
  subOrgId: string
): Promise<CheckCreditResult> {
  if (!subOrgId || typeof subOrgId !== "string") {
    return { success: false, error: "subOrgId is required" };
  }

  try {
    const result = await db
      .select({
        totalCents: sql<string>`COALESCE(SUM(${agenticWalletCredits.amountUsdcCents}), 0)::text`,
      })
      .from(agenticWalletCredits)
      .where(eq(agenticWalletCredits.subOrgId, subOrgId));

    const rawCents = result[0]?.totalCents ?? "0";
    const totalCents = Number.parseInt(rawCents, 10);
    if (!Number.isFinite(totalCents)) {
      return { success: false, error: "Invalid credit balance calculated" };
    }

    const amountUsd = (totalCents / 100).toFixed(2);
    return { success: true, amount: amountUsd, currency: "USD", subOrgId };
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Agentic] in-process /credit read failed",
      error,
      { subOrgId }
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : "Credit query failed",
    };
  }
}

/**
 * Signs a payment challenge in-process using Turnkey primitives.
 */
export async function signPaymentInProcess(
  input: SignPaymentCoreInput,
  subOrgId: string
): Promise<SignPaymentResult> {
  if (!subOrgId) {
    return { success: false, status: "error", error: "subOrgId is required" };
  }
  if (!input.workflowSlug) {
    return {
      success: false,
      status: "error",
      error: "workflowSlug is required",
      code: "WORKFLOW_SLUG_REQUIRED",
    };
  }

  const walletRows = await db
    .select({
      walletAddressBase: agenticWallets.walletAddressBase,
      walletAddressTempo: agenticWallets.walletAddressTempo,
    })
    .from(agenticWallets)
    .where(eq(agenticWallets.subOrgId, subOrgId));

  const wallet = walletRows[0];
  if (!wallet) {
    return {
      success: false,
      status: "error",
      error: "Wallet not found for subOrgId",
      code: "WALLET_NOT_FOUND",
    };
  }

  const walletAddress =
    input.chain === "base"
      ? wallet.walletAddressBase
      : (wallet.walletAddressTempo ?? wallet.walletAddressBase);

  if (!walletAddress) {
    return {
      success: false,
      status: "error",
      error: `No wallet address configured for chain ${input.chain}`,
      code: "WALLET_NOT_FOUND",
    };
  }

  const challenge =
    typeof input.paymentChallenge === "string"
      ? (JSON.parse(input.paymentChallenge) as Record<string, unknown>)
      : (input.paymentChallenge as Record<string, unknown>);

  const callerPayTo = String(challenge.payTo ?? challenge.recipient ?? "");
  const callerAmount = String(challenge.amount ?? "0");

  const binding = await verifyWorkflowBinding(
    input.workflowSlug,
    input.chain,
    callerPayTo,
    callerAmount
  );

  if (!binding.ok) {
    return {
      success: false,
      status: "blocked",
      error: binding.error,
      code: binding.code,
    };
  }

  const risk = classifyRisk({
    chain: input.chain,
    challenge: {
      amount: binding.expectedAmountMicro,
      payTo: binding.expectedPayTo,
    },
  });

  if (risk === "block") {
    return {
      success: false,
      status: "blocked",
      error: "Operation blocked by risk policy",
      code: "POLICY_BLOCKED",
    };
  }

  if (risk === "ask") {
    const approvalBinding = deriveApprovalBinding(input.chain, challenge);
    if (!approvalBinding) {
      return {
        success: false,
        status: "error",
        error: "paymentChallenge missing valid recipient and amount",
        code: "BINDING_REQUIRED",
      };
    }
    const ar = await createApprovalRequest({
      subOrgId,
      riskLevel: "ask",
      operationPayload: { chain: input.chain, paymentChallenge: challenge },
      binding: approvalBinding,
    });
    return {
      success: true,
      status: "pending_approval",
      approvalRequestId: ar.id,
    };
  }

  const reserveAmount = BigInt(binding.expectedAmountMicro);
  const reservation = await reserveSpend(subOrgId, reserveAmount);
  if (!reservation.ok) {
    return {
      success: false,
      status: "blocked",
      error: "Daily spend cap exceeded",
      code: "DAILY_CAP_EXCEEDED",
    };
  }

  try {
    let signature: string;
    if (input.chain === "base") {
      signature = await signX402Challenge(subOrgId, walletAddress, {
        payTo: callerPayTo,
        amount: binding.expectedAmountMicro,
        validAfter: Number(challenge.validAfter ?? 0),
        validBefore: Number(challenge.validBefore ?? 0),
        nonce: String(challenge.nonce ?? ""),
      });
    } else {
      const serialized = String(challenge.serialized ?? "");
      const peeked = Challenge.deserialize(
        serialized.startsWith("Payment ") ? serialized : `Payment ${serialized}`
      );
      if (peeked.intent === "charge") {
        signature = await signMppTransaction(subOrgId, walletAddress, {
          chainId: TEMPO_MAINNET_CHAIN_ID,
          serialized,
        });
      } else {
        signature = await signMppProof(subOrgId, walletAddress, {
          chainId: TEMPO_MAINNET_CHAIN_ID,
          serialized,
        });
      }
    }

    await recordAuditEvent({
      actor: { userId: null, organizationId: null, authMethod: "internal" },
      action: "agentic_wallet.signed",
      resourceType: "agentic_wallet",
      resourceId: subOrgId,
      metadata: { chain: input.chain, workflowSlug: input.workflowSlug },
    });

    return { success: true, status: "signed", signature };
  } catch (err) {
    await rollbackSpend(subOrgId, reserveAmount);
    if (err instanceof PolicyBlockedError) {
      return {
        success: false,
        status: "blocked",
        error: err.message,
        code: "POLICY_BLOCKED",
      };
    }
    if (err instanceof TurnkeyUpstreamError) {
      return {
        success: false,
        status: "error",
        error: err.message,
        code: "TURNKEY_UPSTREAM",
      };
    }
    return {
      success: false,
      status: "error",
      error: err instanceof Error ? err.message : "Signing failed",
    };
  }
}

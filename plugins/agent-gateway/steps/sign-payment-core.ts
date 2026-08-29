/**
 * Core sign-payment-challenge logic shared between the agent-gateway step
 * and its integration test.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * Proxies POST /api/agentic-wallet/sign - see that route for the full
 * request/response contract. The server resolves the sub-org from the
 * HMAC-verified headers (never from the body), classifies the operation's
 * risk, and either signs immediately (200), queues a human approval (202),
 * or blocks (403). This step surfaces all three outcomes as distinct,
 * non-error results rather than throwing, since a 202 "pending approval" is
 * an expected outcome, not a failure.
 */
import "server-only";

import type { HmacCredentials } from "./hmac-request-core";
import { hmacSignedRequest } from "./hmac-request-core";

export type SignPaymentCoreInput = HmacCredentials & {
  chain: "base" | "tempo";
  workflowSlug?: string;
  paymentChallenge: unknown;
};

export type SignPaymentResult =
  | { success: true; status: "signed"; signature: string }
  | { success: true; status: "pending_approval"; approvalRequestId: string }
  | { success: false; status: "blocked" | "error"; error: string; code?: string };

export async function signPaymentCore(
  input: SignPaymentCoreInput
): Promise<SignPaymentResult> {
  if (!(input.subOrgId && input.hmacSecret)) {
    return {
      success: false,
      status: "error",
      error:
        "Missing agent-gateway credentials (subOrgId / hmacSecret). Provision a wallet via POST /api/agentic-wallet/provision and configure this connection with the returned subOrgId and hmacSecret.",
    };
  }

  if (!input.paymentChallenge) {
    return {
      success: false,
      status: "error",
      error: "paymentChallenge is required",
    };
  }

  let response: Response;
  try {
    response = await hmacSignedRequest(
      { subOrgId: input.subOrgId, hmacSecret: input.hmacSecret },
      "POST",
      "/api/agentic-wallet/sign",
      {
        chain: input.chain,
        ...(input.workflowSlug ? { workflowSlug: input.workflowSlug } : {}),
        paymentChallenge: input.paymentChallenge,
      }
    );
  } catch (error) {
    return {
      success: false,
      status: "error",
      error: error instanceof Error ? error.message : "Request failed",
    };
  }

  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (response.status === 200 && typeof data.signature === "string") {
    return { success: true, status: "signed", signature: data.signature };
  }

  if (response.status === 202 && typeof data.approvalRequestId === "string") {
    return {
      success: true,
      status: "pending_approval",
      approvalRequestId: data.approvalRequestId,
    };
  }

  return {
    success: false,
    status: response.status === 403 ? "blocked" : "error",
    error:
      typeof data.error === "string"
        ? data.error
        : `Request failed with status ${response.status}`,
    code: typeof data.code === "string" ? data.code : undefined,
  };
}

/**
 * Core check-credit-balance logic shared between the agent-gateway step and
 * its integration test.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 *
 * Reads the sub-org's off-chain KeeperHub credit ledger via
 * GET /api/agentic-wallet/credit (see that route for the response contract).
 */
import "server-only";

import type { HmacCredentials } from "./hmac-request-core";
import { hmacSignedRequest } from "./hmac-request-core";

export type CheckCreditCoreInput = HmacCredentials;

export type CheckCreditResult =
  | { success: true; amount: string; currency: string; subOrgId: string }
  | { success: false; error: string; code?: string };

export async function checkCreditCore(
  input: CheckCreditCoreInput
): Promise<CheckCreditResult> {
  if (!(input.subOrgId && input.hmacSecret)) {
    return {
      success: false,
      error:
        "Missing agent-gateway credentials (subOrgId / hmacSecret). Provision a wallet via POST /api/agentic-wallet/provision and configure this connection with the returned subOrgId and hmacSecret.",
    };
  }

  let response: Response;
  try {
    response = await hmacSignedRequest(
      { subOrgId: input.subOrgId, hmacSecret: input.hmacSecret },
      "GET",
      "/api/agentic-wallet/credit"
    );
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Request failed",
    };
  }

  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    return {
      success: false,
      error:
        typeof data.error === "string"
          ? data.error
          : `Request failed with status ${response.status}`,
      code: typeof data.code === "string" ? data.code : undefined,
    };
  }

  return {
    success: true,
    amount: String(data.amount),
    currency: String(data.currency),
    subOrgId: String(data.subOrgId),
  };
}

import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type {
  SignPaymentCoreInput,
  SignPaymentResult,
} from "./sign-payment-core";
import { signPaymentCore } from "./sign-payment-core";

export type { SignPaymentResult } from "./sign-payment-core";

export type SignPaymentInput = StepInput & SignPaymentCoreInput;

/**
 * Sign Payment Challenge Step
 * Settles an x402 (Base) or MPP (Tempo) payment challenge by requesting a
 * Turnkey-backed signature from the agent's sub-org wallet via the
 * HMAC-authenticated /api/agentic-wallet/sign endpoint.
 */
export async function signPaymentStep(
  input: SignPaymentInput
): Promise<SignPaymentResult> {
  "use step";

  return runPluginStep(
    { pluginName: "agent-gateway", actionName: "sign-payment" },
    input,
    signPaymentCore
  );
}

// Security-critical: do not auto-retry a signing call. A retried sign
// produces a fresh Turnkey signature the caller's downstream retry could
// resubmit as a duplicate settlement attempt.
signPaymentStep.maxRetries = 0;

export const _integrationType = "agent-gateway";

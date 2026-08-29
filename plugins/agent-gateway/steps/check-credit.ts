import "server-only";

import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type {
  CheckCreditCoreInput,
  CheckCreditResult,
} from "./check-credit-core";
import { checkCreditCore } from "./check-credit-core";

export type { CheckCreditResult } from "./check-credit-core";

export type CheckCreditInput = StepInput & CheckCreditCoreInput;

/**
 * Check Credit Balance Step
 * Reads the agent's off-chain KeeperHub credit balance via the
 * HMAC-authenticated /api/agentic-wallet/credit endpoint.
 */
export async function checkCreditStep(
  input: CheckCreditInput
): Promise<CheckCreditResult> {
  "use step";

  return runPluginStep(
    { pluginName: "agent-gateway", actionName: "check-credit" },
    input,
    checkCreditCore
  );
}

export const _integrationType = "agent-gateway";

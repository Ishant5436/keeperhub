import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  type ReadSolanaAccountCoreInput,
  type ReadSolanaAccountResult,
  readSolanaAccountCore,
} from "./read-solana-account-core";

export type {
  ReadSolanaAccountCoreInput,
  ReadSolanaAccountResult,
} from "./read-solana-account-core";

export type ReadSolanaAccountInput = StepInput & ReadSolanaAccountCoreInput;

/**
 * Read Solana Account Step
 * Reads the raw account info (owner, lamports, data) for a Solana address.
 */
export async function readSolanaAccountStep(
  input: ReadSolanaAccountInput
): Promise<ReadSolanaAccountResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "read-solana-account",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => readSolanaAccountCore(input))
  );
}

readSolanaAccountStep.maxRetries = 0;

export const _integrationType = "web3";

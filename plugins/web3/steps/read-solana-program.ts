import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import {
  type ReadSolanaProgramCoreInput,
  type ReadSolanaProgramResult,
  readSolanaProgramCore,
} from "./read-solana-program-core";

export type {
  ReadSolanaProgramCoreInput,
  ReadSolanaProgramResult,
} from "./read-solana-program-core";

export type ReadSolanaProgramInput = StepInput & ReadSolanaProgramCoreInput;

/**
 * Read Solana Program (Anchor) Step
 * Reads a Solana account and decodes it against a supplied Anchor IDL.
 */
export async function readSolanaProgramStep(
  input: ReadSolanaProgramInput
): Promise<ReadSolanaProgramResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "read-solana-program-anchor",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => readSolanaProgramCore(input))
  );
}

readSolanaProgramStep.maxRetries = 0;

export const _integrationType = "web3";

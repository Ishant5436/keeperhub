import "server-only";

import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";
import type {
  QuerySolanaProgramEventsCoreInput,
  QuerySolanaProgramEventsResult,
} from "./query-solana-program-events-core";
import { queryProgramEventsCore } from "./query-solana-program-events-core";

export type {
  QuerySolanaProgramEventsCoreInput,
  QuerySolanaProgramEventsResult,
} from "./query-solana-program-events-core";

export type QuerySolanaProgramEventsInput = StepInput &
  QuerySolanaProgramEventsCoreInput;

/**
 * Query Solana Program Events Step
 * Pages getSignaturesForAddress/getTransaction backward from a signature
 * cursor to retrieve past program events for backfill/reconciliation, since
 * Solana has no batched, event-filtered equivalent of eth_getLogs.
 */
export async function querySolanaProgramEventsStep(
  input: QuerySolanaProgramEventsInput
): Promise<QuerySolanaProgramEventsResult> {
  "use step";

  return withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "query-solana-program-events",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(input, () => queryProgramEventsCore(input))
  );
}

querySolanaProgramEventsStep.maxRetries = 0;

export const _integrationType = "web3";

/**
 * Shared "is this actionType a write action" check. Used by both the MCP
 * calldata generator (calldata.ts) and the deep validator
 * (validate-workflow-deep.ts) so the two classifications cannot drift.
 *
 * web3/batch-write-contract matches too: calldata.ts encodes it as a single
 * aggregate3(Call3[]) call against Multicall3, so it is exactly as
 * calldata-generatable as a single write-contract call, just via a different
 * encoder. See generateCalldataForWorkflow's batch branch.
 */
export const BATCH_WRITE_CONTRACT_ACTION_TYPE = "web3/batch-write-contract";

export function isWriteActionType(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  return (
    actionType.includes("write-contract") ||
    actionType.includes("protocol-write")
  );
}

// Mutating action types that isWriteActionType deliberately excludes because
// they cannot be served by the MCP calldata-handoff route: their config
// carries no raw ABI/function/args at all (e.g. approve-token's config is
// tokenConfig/spenderAddress/amount), so encoding one requires action-specific
// semantic knowledge the calldata generator does not have. They do genuinely
// broadcast a signed transaction from the org wallet, though. Kept separate
// from isWriteActionType, which callers rely on staying in lockstep with the
// calldata generator; widening it here would let a workflow using one of
// these actions validate as workflowType="write" and then fail every real
// MCP call with "No write action node found in workflow".
const NON_CALLDATA_MUTATING_ACTION_TYPES = new Set([
  "web3/approve-token",
  "web3/transfer-funds",
  "web3/transfer-token",
]);

/**
 * Broader than isWriteActionType: true for any action type that mutates
 * chain state, whether or not it can be served by the calldata-handoff
 * route. Use this for signals that describe real-world effect (e.g. an MCP
 * tool's readOnlyHint annotation), never for anything that gates the
 * calldata-generation/workflowType="write" path, which must stay scoped to
 * isWriteActionType.
 */
export function isMutatingActionType(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  return (
    NON_CALLDATA_MUTATING_ACTION_TYPES.has(actionType) ||
    isWriteActionType(actionType)
  );
}

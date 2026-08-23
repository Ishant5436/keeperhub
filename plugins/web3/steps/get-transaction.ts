import "server-only";

import type { VersionedTransactionResponse } from "@solana/web3.js";
import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { explorerConfigs, workflowExecutions } from "@/lib/db/schema";
import { getAddressUrl, getTransactionUrl } from "@/lib/explorer";
import { withPluginMetrics } from "@/lib/metrics/instrumentation/plugin";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import {
  getRpcProvider,
  getSolanaProvider,
  isSolanaChain,
} from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { type StepInput, withStepLogging } from "@/lib/workflow/executor/step-handler";
import { getErrorMessage } from "@/lib/utils";
import { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";
import { validateChainTxHash } from "@/lib/web3/validate-chain-address";

/**
 * Index 0 of a transaction's account keys is always the fee payer - the
 * same convention SolanaChainAdapter relies on when reading back simulated
 * fee-payer state (see solana.ts's buildSignAndSimulate).
 */
function getSolanaFeePayer(tx: VersionedTransactionResponse): string {
  const feePayer = tx.transaction.message
    .getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
    .get(0);
  if (!feePayer) {
    throw new Error(
      "[Get Transaction] Transaction has no fee payer account key"
    );
  }
  return feePayer.toBase58();
}

async function getUserIdFromExecution(
  executionId: string | undefined
): Promise<string | undefined> {
  if (!executionId) {
    return;
  }

  const execution = await db
    .select({ userId: workflowExecutions.userId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, executionId))
    .limit(1);

  return execution[0]?.userId;
}

type GetTransactionResult =
  | {
      success: true;
      hash: string;
      from: string;
      to: string | null;
      value: string;
      input: string;
      nonce: number;
      gasLimit: string;
      // Solana only: actual compute units consumed. Not comparable to
      // gasLimit (an EVM ceiling the transaction was allowed to spend, not
      // what it used), so it is reported as its own field rather than
      // overloading gasLimit with a different quantity.
      computeUnitsConsumed?: string;
      blockNumber: number | null;
      transactionLink: string;
      fromLink: string;
      toLink: string;
    }
  | { success: false; error: string };

export type GetTransactionCoreInput = {
  network: string;
  transactionHash: string;
};

export type GetTransactionInput = StepInput & GetTransactionCoreInput;

/**
 * EVM branch: resolve an RPC provider and fetch the transaction.
 */
async function fetchEvmTransaction(
  hash: string,
  chainId: number,
  userId: string | undefined
): Promise<GetTransactionResult> {
  let rpcManager: RpcProviderManager;
  try {
    rpcManager = await getRpcProvider({ chainId, userId });
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }

  const tx = await rpcManager.executeWithFailover(async (provider) =>
    provider.getTransaction(hash)
  );

  if (!tx) {
    return { success: false, error: `Transaction not found: ${hash}` };
  }

  const explorerConfig = await db.query.explorerConfigs.findFirst({
    where: eq(explorerConfigs.chainId, chainId),
  });
  const transactionLink = explorerConfig
    ? getTransactionUrl(explorerConfig, hash)
    : "";
  const fromLink = explorerConfig
    ? getAddressUrl(explorerConfig, tx.from)
    : "";
  const toLink =
    explorerConfig && tx.to ? getAddressUrl(explorerConfig, tx.to) : "";

  return {
    success: true,
    hash: tx.hash,
    from: tx.from,
    to: tx.to,
    value: ethers.formatEther(tx.value),
    input: tx.data,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit.toString(),
    blockNumber: tx.blockNumber,
    transactionLink,
    fromLink,
    toLink,
  };
}

/**
 * Solana branch: a fresh, userId-aware adapter is constructed directly
 * (bypassing getChainAdapter's chainId-only cache) so a user's custom RPC
 * preference is actually honored here, the same way getRpcProvider({chainId,
 * userId}) already honors it on the EVM branch above.
 */
async function fetchSolanaTransaction(
  hash: string,
  chainId: number,
  userId: string | undefined
): Promise<GetTransactionResult> {
  const adapter = new SolanaChainAdapter(chainId, () =>
    getSolanaProvider({ chainId, userId })
  );
  const tx = await adapter.executeWithSolanaFailover((connection) =>
    connection.getTransaction(hash, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })
  );

  if (!tx) {
    return { success: false, error: `Transaction not found: ${hash}` };
  }

  const feePayer = getSolanaFeePayer(tx);
  const explorerConfig = await db.query.explorerConfigs.findFirst({
    where: eq(explorerConfigs.chainId, chainId),
  });
  const transactionLink = explorerConfig
    ? getTransactionUrl(explorerConfig, hash)
    : "";
  const fromLink = explorerConfig
    ? getAddressUrl(explorerConfig, feePayer)
    : "";

  return {
    success: true,
    hash,
    from: feePayer,
    // Solana has no single recipient: a transaction is a list of
    // instructions, each with its own accounts.
    to: null,
    // Solana has no single top-level transfer amount the way an EVM
    // transaction does.
    value: "0",
    input: "",
    nonce: 0,
    // No fixed compute ceiling is reported by this RPC call; actual usage is
    // reported separately via computeUnitsConsumed below.
    gasLimit: "0",
    computeUnitsConsumed: String(tx.meta?.computeUnitsConsumed ?? 0),
    blockNumber: tx.slot,
    transactionLink,
    fromLink,
    toLink: "",
  };
}

async function stepHandler(
  input: GetTransactionInput
): Promise<GetTransactionResult> {
  const { network, transactionHash, _context } = input;

  if (!transactionHash?.trim()) {
    return {
      success: false,
      error: "Transaction hash is required",
    };
  }

  const hash = transactionHash.trim();

  // Resolve the chain first so hash-format validation can branch on the
  // chain family (EVM vs Solana) - see lib/web3/validate-chain-address.ts.
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }

  if (!validateChainTxHash(hash, chainId)) {
    return {
      success: false,
      error: `Invalid transaction hash format: ${hash}`,
    };
  }

  const userId = await getUserIdFromExecution(_context?.executionId);

  try {
    return isSolanaChain(chainId)
      ? await fetchSolanaTransaction(hash, chainId, userId)
      : await fetchEvmTransaction(hash, chainId, userId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to fetch transaction: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * Get Transaction Step
 * Fetches full transaction details by hash via eth_getTransactionByHash.
 * Returns from, to, value, input (calldata), nonce, gas, and explorer links.
 */
export async function getTransactionStep(
  input: GetTransactionInput
): Promise<GetTransactionResult> {
  "use step";

  let enrichedInput: GetTransactionInput & { transactionLink?: string } = input;
  try {
    const chainId = getChainIdFromNetwork(input.network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });
    if (explorerConfig) {
      const transactionLink = getTransactionUrl(
        explorerConfig,
        input.transactionHash
      );
      if (transactionLink) {
        enrichedInput = { ...input, transactionLink };
      }
    }
  } catch {
    // Non-critical: if lookup fails, input logs without the link
  }

  return await withPluginMetrics(
    {
      pluginName: "web3",
      actionName: "get-transaction",
      executionId: input._context?.executionId,
    },
    () => withStepLogging(enrichedInput, () => stepHandler(input))
  );
}

getTransactionStep.maxRetries = 0;

export const _integrationType = "web3";

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ethers } from "ethers";
import { isSolanaChain } from "@/lib/rpc/provider-factory";

const EVM_TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const SOLANA_SIGNATURE_BYTE_LENGTH = 64;

/**
 * Validates an address against the format the chain actually uses: base58
 * for Solana, 0x-hex for EVM. A chain-agnostic address check rejects valid
 * input from the "other" family, so callers must resolve chainId before
 * validating - see check-balance.ts for the reference pattern this mirrors.
 */
export function validateChainAddress(
  address: string,
  chainId: number
): boolean {
  if (isSolanaChain(chainId)) {
    try {
      // Throws on non-base58 / wrong-length input.
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }
  return ethers.isAddress(address);
}

/**
 * Validates a transaction hash/signature against the chain's format: a
 * 64-byte base58 signature for Solana, a 32-byte 0x-hex hash for EVM.
 */
export function validateChainTxHash(hash: string, chainId: number): boolean {
  if (isSolanaChain(chainId)) {
    try {
      return bs58.decode(hash).length === SOLANA_SIGNATURE_BYTE_LENGTH;
    } catch {
      return false;
    }
  }
  return EVM_TX_HASH_PATTERN.test(hash);
}

/**
 * Guard for actions that only understand EVM (ABI-decoded logs/calls have no
 * Solana equivalent). Returns a ready-to-return failure result for a Solana
 * chainId, or null when the chain is fine - shared so the guard condition and
 * message live in one place instead of being copy-pasted per action.
 */
export function evmOnlyGuard(
  chainId: number
): { success: false; error: string } | null {
  return isSolanaChain(chainId)
    ? { success: false, error: "Solana is not supported for this action yet" }
    : null;
}

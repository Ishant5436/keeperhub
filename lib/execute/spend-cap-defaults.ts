/**
 * Platform default value caps, applied whenever an organization has not
 * configured a cap of its own.
 *
 * Before these existed, a missing `organization_spend_caps` row -- or a null
 * column for one chain family -- meant unlimited. Only an admin visiting the
 * spend-cap UI ever created a row, so every organization was unlimited by
 * default and a leaked API key was bounded only by the wallet balance. The
 * caps below are the fail-closed floor: an organization must raise its own
 * ceiling deliberately rather than inherit an unbounded one.
 *
 * The two native figures are denominated in the native asset, NOT in USD, so
 * their USD worth drifts with the market: if ETH doubles, the real ceiling
 * doubles with it and nothing alerts. A Chainlink native/USD read does exist in
 * this codebase (`getNativeUsdPrice` in lib/safe/price-oracle.ts, 60s cached,
 * used pre-broadcast by the Safe simulate routes), but the reservation runs
 * inside a `SELECT ... FOR UPDATE` transaction and neither reservation entry
 * point carries a chain id -- `reserveOrgValue` has none at all -- so pricing
 * here would mean holding a row lock across an RPC round trip on a path that
 * has no chain to price. The figures are therefore fixed, chosen at the
 * reference price stated on each, and the drift is accepted deliberately.
 *
 * Each default is overridable from the environment, and both values.yaml files
 * set it explicitly for the app and the executor, so widening one that is
 * binding a live integrator is a values edit and a release rather than a code
 * change. It is not instant: `type: kv` means the new figure ships with a helm
 * upgrade. Anything faster would need the key moved to parameterStore, where a
 * value change plus a pod restart is enough.
 *
 * (`AGENTIC_WALLET_DAILY_CAP_MICROS` makes the same "tune without a deploy"
 * claim and is wired into neither environment, so it is not the precedent it
 * appears to be.)
 */

// The reference ceiling these are chosen against is the 200 USD/day figure
// lib/agentic-wallet/daily-spend.ts already applies to agent-signed spend --
// the one ratified spend-policy number in the codebase. Each default below
// sits at or under it deliberately: a default that binds too tightly is a
// values.yaml edit, while one that binds too loosely is an unbounded outflow
// nobody notices. The rollout
// widens from here on evidence (watch spend_cap_default_applied), rather than
// starting wide and tightening after an incident.

// 0.02 ETH, about 80 USD at a 4,000 USD/ETH reference price.
//
// Denominated in ETH, not USD, so the realized ceiling moves with the market.
// The figure is picked so that drift cannot carry it above the 200 USD anchor
// until ETH passes roughly 10,000 USD -- the upward direction is the dangerous
// one, because nothing alerts when a cap silently widens. Applies to every EVM
// chain, testnets included, because the ledger column it is compared against is
// chain-agnostic.
const DEFAULT_DAILY_VALUE_CAP_WEI = "20000000000000000";

// 0.5 SOL, about 100 USD at a 200 USD/SOL reference price. Same drift
// reasoning: stays under the 200 USD anchor until SOL passes roughly 400 USD.
const DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS = "500000000";

// BigInt() accepts hex-prefixed strings ("0x10" -> 16), so an ops typo would
// silently turn a cap into a near-zero one. Reject anything that is not a
// decimal digit run before it is used.
const DECIMAL_INTEGER_RE = /^\d+$/;

function resolveOverride(
  envValue: string | undefined,
  fallback: string
): string {
  if (!(envValue && DECIMAL_INTEGER_RE.test(envValue))) {
    return fallback;
  }
  return BigInt(envValue) > BigInt(0) ? envValue : fallback;
}

/** Default daily EVM native value cap, in wei. */
export function getDefaultDailyValueCapWei(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_DAILY_VALUE_CAP_WEI,
    DEFAULT_DAILY_VALUE_CAP_WEI
  );
}

/** Default daily Solana native value cap, in lamports. */
export function getDefaultDailySolanaValueCapLamports(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS,
    DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS
  );
}

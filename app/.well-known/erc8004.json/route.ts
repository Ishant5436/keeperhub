// Canonical ERC-8004 metadata for the KeeperHub agent. Lets third-party
// indexers (e.g. 8004scan) and reputation readers discover KH's registered
// agent identity, registry contract, and where to fetch richer cards from
// — without round-tripping through MCP or the on-chain registry directly.
//
// KEEP-475: this endpoint used to return 404, forcing callers to query the
// canonical Ethereum mainnet registries on chain to find KH. The agent
// already exists (see the erc8004 block in the mcp.json route); only the
// well-known wrapper was missing.
//
// Identity and reputation are SEPARATE ERC-8004 contracts. Every address and
// id below is imported from lib/agentic-wallet/constants.ts — the same source
// of truth the feedback route and the Turnkey policy use — so the pointers we
// publish cannot drift from where feedback is actually written on chain.

import {
  ERC_8004_IDENTITY_REGISTRY_ADDRESS,
  ERC_8004_REPUTATION_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
  KEEPERHUB_ERC_8004_AGENT_ID,
} from "@/lib/agentic-wallet/constants";

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const card = {
    schema_version: "1",
    name: "KeeperHub",
    description:
      "Execution layer for AI agents operating onchain. ERC-8004 agent identity for KeeperHub workflows.",
    agent_id: KEEPERHUB_ERC_8004_AGENT_ID,
    chain: "ethereum",
    chain_id: ETHEREUM_MAINNET_CHAIN_ID,
    registry: ERC_8004_IDENTITY_REGISTRY_ADDRESS,
    cards: {
      mcp: `${baseUrl}/.well-known/mcp.json`,
      a2a: `${baseUrl}/.well-known/agent-card.json`,
    },
    endpoints: {
      mcp: `${baseUrl}/mcp`,
      api: `${baseUrl}/api`,
    },
    reputation: {
      type: "erc-8004",
      // Feedback writes flow through the agentic-wallet path; consumers
      // read directly from the on-chain ReputationRegistry — a different
      // contract from the IdentityRegistry above.
      registry: ERC_8004_REPUTATION_REGISTRY_ADDRESS,
      chain_id: ETHEREUM_MAINNET_CHAIN_ID,
    },
  };

  return Response.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  ERC_8004_IDENTITY_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
} from "@/lib/agentic-wallet/constants";
import { db } from "@/lib/db";
import { agentRegistrations } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getAuthenticatedToolsForDiscovery } from "@/lib/mcp/mcp-tool-catalog";

// Shares its chain id and registry address with scripts/register-agent.ts via
// lib/agentic-wallet/constants.ts, so the row this endpoint looks up cannot
// drift from the row the registration script writes. The endpoint serves the
// public ERC-8004 discovery payload and must return the canonical mainnet
// registration regardless of how many other (chain, registry) rows exist in
// the table.
const MAINNET_CHAIN_ID = ETHEREUM_MAINNET_CHAIN_ID;
const IDENTITY_REGISTRY_ADDRESS = ERC_8004_IDENTITY_REGISTRY_ADDRESS;

export async function GET(_request: Request): Promise<NextResponse> {
  try {
    const rows = await db
      .select()
      .from(agentRegistrations)
      .where(
        and(
          eq(agentRegistrations.chainId, MAINNET_CHAIN_ID),
          eq(agentRegistrations.registryAddress, IDENTITY_REGISTRY_ADDRESS)
        )
      )
      .limit(1);
    const registration = rows[0] ?? null;

    const registrationJson = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "KeeperHub",
      description:
        "Web3 workflow automation platform. Build and deploy on-chain automations through a visual builder. Workflows are callable by AI agents via MCP.",
      image: "https://app.keeperhub.com/keeperhub_logo.png",
      services: [
        {
          name: "MCP",
          endpoint: "https://app.keeperhub.com/.well-known/mcp.json",
          version: "2025-06-18",
          mcpTools: getAuthenticatedToolsForDiscovery(),
        },
        {
          name: "A2A",
          endpoint: "https://app.keeperhub.com/.well-known/agent-card.json",
          version: "0.3.0",
        },
        {
          name: "workflows",
          endpoint: "https://app.keeperhub.com/api/mcp/workflows",
        },
        { name: "web", endpoint: "https://app.keeperhub.com" },
        { name: "ens", endpoint: "keeperhub.eth" },
        {
          name: "agentWallet",
          endpoint: "eip155:1:0xaa70faa583c0889164cfd9b45aa075f6c4388fee",
        },
      ],
      supportedTrust: ["reputation"],
      x402Support: true,
      active: true,
      updatedAt: registration
        ? Math.floor(registration.registeredAt.getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      registrations: registration
        ? [
            {
              agentId: registration.agentId,
              agentRegistry: `eip155:1:${registration.registryAddress}`,
            },
          ]
        : [],
    };

    return NextResponse.json(registrationJson, {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[agent-registry] Failed to load registration",
      err,
      { endpoint: "/api/agent-registry" }
    );
    return NextResponse.json(
      { error: "Failed to load agent registry" },
      { status: 500 }
    );
  }
}

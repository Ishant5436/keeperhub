import { afterEach, describe, expect, it } from "vitest";
import type {
  DiscoveryData,
  NetworkConfig,
  RawTriggerConfig,
  RawWorkflow,
} from "../../lib/types";
import { buildRegistrations } from "../../src/mapper";

const VALID_PROGRAM = "So11111111111111111111111111111111111111112";

function solanaNetwork(
  chainId: number,
  overrides: Partial<NetworkConfig> = {},
): NetworkConfig {
  return {
    id: `chain-${chainId}`,
    chainId,
    name: `Solana ${chainId}`,
    symbol: "SOL",
    chainType: "solana",
    defaultPrimaryRpc: "https://rpc.example",
    defaultFallbackRpc: "",
    defaultPrimaryWss: "wss://ws.example",
    defaultFallbackWss: "",
    isTestnet: false,
    isEnabled: true,
    ...overrides,
  };
}

function eventWorkflow(
  id: string,
  network: string,
  programId: string,
  extra: Partial<RawTriggerConfig> = {},
): RawWorkflow {
  return {
    id,
    userId: "user-1",
    name: id,
    nodes: [
      {
        data: {
          type: "trigger",
          config: { triggerType: "Event", network, programId, ...extra },
        },
      },
    ],
  };
}

function blockWorkflow(
  id: string,
  network: string,
  blockInterval?: string,
): RawWorkflow {
  return {
    id,
    userId: "user-1",
    name: id,
    nodes: [
      {
        data: {
          type: "trigger",
          config: { triggerType: "Block", network, blockInterval },
        },
      },
    ],
  };
}

function data(overrides: Partial<DiscoveryData>): DiscoveryData {
  return {
    eventWorkflows: [],
    blockWorkflows: [],
    networks: {},
    ...overrides,
  };
}

afterEach(() => {
  // Empty (not "signatures") so the mapper's env check yields the default mode.
  process.env.SOLANA_SOURCE_MODE = "";
});

describe("buildRegistrations", () => {
  it("builds one registration per Solana chain with resolved endpoints", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    expect(regs).toHaveLength(1);
    expect(regs[0].chainId).toBe(101);
    expect(regs[0].eventTriggers).toHaveLength(1);
    expect(regs[0].eventTriggers[0].programId).toBe(VALID_PROGRAM);
    expect(regs[0].rpcUrl).toBe("https://rpc.example");
    expect(regs[0].wssUrl).toBe("wss://ws.example");
    expect(regs[0].commitment).toBe("confirmed");
  });

  it("skips event triggers whose programId is not valid base58", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", "not-a-valid-key!!!")],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    expect(regs).toEqual([]);
  });

  it("parses block interval and defaults invalid/absent intervals to 1", () => {
    const regs = buildRegistrations(
      data({
        blockWorkflows: [
          blockWorkflow("wf-5", "101", "5"),
          blockWorkflow("wf-x", "101"),
        ],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    const intervals = regs[0].blockTriggers
      .map((t) => t.blockInterval)
      .sort((a, b) => a - b);
    expect(intervals).toEqual([1, 5]);
  });

  it("skips a chain whose network lacks a usable WSS endpoint", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
        networks: { 101: solanaNetwork(101, { defaultPrimaryWss: "" }) },
      }),
    );
    expect(regs).toEqual([]);
  });

  it("skips non-Solana chains", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "1", VALID_PROGRAM)],
        networks: { 1: solanaNetwork(1, { chainType: "evm" }) },
      }),
    );
    expect(regs).toEqual([]);
  });

  it("defaults mainnet event ingestion to the filtered signatures source", () => {
    // getBlock pulls every produced block in full; on mainnet that is a
    // firehose no CPU request absorbs, and it skips slots (missing triggers)
    // once it falls behind.
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    expect(regs[0].sourceMode).toBe("signatures");
  });

  it("leaves testnet chains on getBlock, where whole-block pulls are cheap", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "103", VALID_PROGRAM)],
        networks: { 103: solanaNetwork(103, { isTestnet: true }) },
      }),
    );
    expect(regs[0].sourceMode).toBeUndefined();
  });

  it("leaves a mainnet chain with only block triggers on getBlock", () => {
    // No event triggers means no full-detail pull: getBlock runs header-only
    // and is the only source that serves block triggers.
    const regs = buildRegistrations(
      data({
        blockWorkflows: [blockWorkflow("wf-b", "101", "1")],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    expect(regs[0].sourceMode).toBeUndefined();
  });

  it("lets SOLANA_SOURCE_MODE override the per-chain default in both directions", () => {
    const mainnet = data({
      eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
      networks: { 101: solanaNetwork(101) },
    });
    const testnet = data({
      eventWorkflows: [eventWorkflow("wf-1", "103", VALID_PROGRAM)],
      networks: { 103: solanaNetwork(103, { isTestnet: true }) },
    });

    process.env.SOLANA_SOURCE_MODE = "getblock";
    expect(buildRegistrations(mainnet)[0].sourceMode).toBe("getblock");

    process.env.SOLANA_SOURCE_MODE = "signatures";
    expect(buildRegistrations(testnet)[0].sourceMode).toBe("signatures");
  });

  it("accepts SOLANA_SOURCE_MODE regardless of case or surrounding space", () => {
    // "getBlock" is the spelling used by the class name, the code comments and
    // the spec, so it is what an operator reaches for under pressure.
    process.env.SOLANA_SOURCE_MODE = " getBlock ";
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    expect(regs[0].sourceMode).toBe("getblock");
  });

  it("treats a chain with an unknown isTestnet as a testnet, not mainnet", () => {
    // chains.is_testnet is nullable and discovery payloads are not validated;
    // a null must not read as mainnet and pull a testnet onto the mainnet path.
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "103", VALID_PROGRAM)],
        networks: {
          103: solanaNetwork(103, {
            isTestnet: undefined as unknown as boolean,
          }),
        },
      }),
    );
    expect(regs[0].sourceMode).toBeUndefined();
  });

  it("ignores an unrecognised SOLANA_SOURCE_MODE and keeps the default", () => {
    process.env.SOLANA_SOURCE_MODE = "geyser";
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    expect(regs[0].sourceMode).toBe("signatures");
  });

  it("changes the config hash when the source mode changes, so the ingestor restarts", () => {
    const input = data({
      eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
      networks: { 101: solanaNetwork(101) },
    });

    const defaultReg = buildRegistrations(input)[0];
    process.env.SOLANA_SOURCE_MODE = "getblock";
    const overriddenReg = buildRegistrations(input)[0];

    expect(overriddenReg.configHash).not.toBe(defaultReg.configHash);
  });
});

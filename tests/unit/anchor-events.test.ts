import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockLogUserError = vi.fn();
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "validation" },
  logUserError: (...args: unknown[]) => mockLogUserError(...args),
}));

import {
  AnchorEventDecoder,
  createEventDecoder,
} from "@/lib/web3/anchor-events";

const PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OTHER_PROGRAM_ID = "So11111111111111111111111111111111111111112";

const DEPOSITED_DISCRIMINATOR = [11, 22, 33, 44, 55, 66, 77, 88];
const IDL: Idl = {
  address: "11111111111111111111111111111111",
  metadata: { name: "test_program", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [],
  events: [{ name: "Deposited", discriminator: DEPOSITED_DISCRIMINATOR }],
  types: [
    {
      name: "Deposited",
      type: { kind: "struct", fields: [{ name: "amount", type: "u64" }] },
    },
  ],
};

function depositedLog(amount: number, prefix = "Program data: "): string {
  const coder = new BorshCoder(IDL);
  const encoded = coder.types.encode("Deposited", { amount: new BN(amount) });
  const blob = Buffer.concat([Buffer.from(DEPOSITED_DISCRIMINATOR), encoded]);
  return `${prefix}${blob.toString("base64")}`;
}

describe("createEventDecoder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no IDL is provided (raw mode)", () => {
    expect(createEventDecoder(undefined, PROGRAM_ID)).toBeNull();
    expect(mockLogUserError).not.toHaveBeenCalled();
  });

  it("returns null and logs for malformed JSON (raw mode)", () => {
    expect(createEventDecoder("{not json", PROGRAM_ID)).toBeNull();
    expect(mockLogUserError).toHaveBeenCalledTimes(1);
  });

  it("returns null and logs when the IDL has no events array", () => {
    const idlWithoutEvents = { ...IDL, events: undefined };
    expect(
      createEventDecoder(JSON.stringify(idlWithoutEvents), PROGRAM_ID)
    ).toBeNull();
    expect(mockLogUserError).toHaveBeenCalledTimes(1);
  });

  it("returns a decoder for a valid IDL", () => {
    expect(createEventDecoder(JSON.stringify(IDL), PROGRAM_ID)).toBeInstanceOf(
      AnchorEventDecoder
    );
    expect(mockLogUserError).not.toHaveBeenCalled();
  });
});

describe("AnchorEventDecoder.decodeLogs", () => {
  it("decodes an event on a well-formed 'Program data:' log line", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      "Program log: instruction: deposit",
      depositedLog(7),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toHaveLength(1);
    expect(events?.[0].name).toBe("Deposited");
    expect(events?.[0].data.amount).toBe("7");
  });

  it("decodes an event on a bare 'Program log:' line while in-context", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(3, "Program log: "),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toHaveLength(1);
    expect(events?.[0].data.amount).toBe("3");
  });

  it("ignores non-event log lines and returns nothing", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      "Program log: nothing here",
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toEqual([]);
  });

  it("skips data blobs that do not match this IDL's discriminator", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program data: ${Buffer.from([0, 1, 2, 3]).toString("base64")}`,
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toEqual([]);
  });

  it("returns nothing when the log array does not open with a well-formed top-level invoke", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    expect(decoder?.decodeLogs([])).toEqual([]);
    expect(decoder?.decodeLogs(["Program log: stray line"])).toEqual([]);
  });

  it("does not attribute an event logged while a CPI'd program is executing", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      `Program ${OTHER_PROGRAM_ID} invoke [2]`,
      depositedLog(999),
      `Program ${OTHER_PROGRAM_ID} success`,
      depositedLog(1),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events).toHaveLength(1);
    expect(events?.[0].data.amount).toBe("1");
  });

  it("resumes decoding this program's own logs after a CPI returns", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(1),
      `Program ${OTHER_PROGRAM_ID} invoke [2]`,
      `Program ${OTHER_PROGRAM_ID} success`,
      depositedLog(2),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events?.map((e) => e.data.amount)).toEqual(["1", "2"]);
  });

  it("handles a second top-level instruction invoking the same program in one transaction", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(1),
      `Program ${PROGRAM_ID} success`,
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(2),
      `Program ${PROGRAM_ID} success`,
    ]);
    expect(events?.map((e) => e.data.amount)).toEqual(["1", "2"]);
  });

  it("normalizes a u64 field to a decimal string that survives JSON.stringify", () => {
    const decoder = createEventDecoder(JSON.stringify(IDL), PROGRAM_ID);
    const events = decoder?.decodeLogs([
      `Program ${PROGRAM_ID} invoke [1]`,
      depositedLog(123_456),
      `Program ${PROGRAM_ID} success`,
    ]);
    const amount = events?.[0].data.amount;
    expect(typeof amount).toBe("string");
    expect(amount).toBe("123456");
    expect(JSON.parse(JSON.stringify(events?.[0].data)).amount).toBe("123456");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  clearEncodeTransforms,
  getEncodeTransformKind,
  registerEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import { synthesiseProtocolTemplate } from "@/lib/workflow/codegen/protocol-synthesiser";

afterEach(() => {
  clearEncodeTransforms();
});

describe("synthesiser: weiToEther kind", () => {
  it("emits the payable value unconverted, which is wei on both sides", () => {
    // The legitimate registration: weiToEther on the virtual ethValue field.
    // The emitted SDK passes `BigInt(input.ethValue)` and so reads the field
    // as wei; with the transform registered the runtime now reads it as wei
    // too (it converts to ether for parseEther). This asserts the state as
    // it is rather than as it ought to be - see the note on the weiToEther
    // branch in protocol-synthesiser.ts for why the two sides disagree for
    // every action *without* the transform, and why reconciling them is a
    // separate change.
    registerEncodeTransform(
      "chainlink",
      "ccip-send",
      "ethValue",
      weiToEther,
      "weiToEther"
    );

    const out = synthesiseProtocolTemplate("chainlink/ccip-send", {
      network: "11155111",
    });
    expect(out).not.toBeNull();
    expect(out as string).toContain("BigInt(input.ethValue)");
    expect(out as string).not.toContain("formatEther");
  });

  it("still does not convert if the ABI-input invariant is ever violated", () => {
    // Registering this kind on a declared ABI input is forbidden - the
    // registry-wide guard lives in
    // tests/unit/protocol-encode-transform-invariants.test.ts, which is
    // where such a registration is meant to be caught. This test does not
    // bless that shape; it pins the blast radius if it ever slips through,
    // namely that the generated SDK leaves the expression alone instead of
    // emitting a conversion or leaking the kind name into source.
    registerEncodeTransform(
      "chainlink",
      "ccip-approve-bridge-token",
      "amount",
      weiToEther,
      "weiToEther"
    );
    expect(
      getEncodeTransformKind("chainlink", "ccip-approve-bridge-token", "amount")
    ).toBe("weiToEther");

    const out = synthesiseProtocolTemplate(
      "chainlink/ccip-approve-bridge-token",
      { network: "11155111" }
    );
    expect(out).not.toBeNull();
    expect(out as string).toContain("BigInt(input.amount)");
    expect(out as string).not.toContain("formatEther");
    expect(out as string).not.toContain("weiToEther");
  });
});

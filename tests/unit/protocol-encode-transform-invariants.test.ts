/**
 * Registry-wide invariants for encode transforms.
 *
 * Deliberately separate from protocol-encode-transforms.test.ts: that file
 * clears the registry in afterEach, which would also wipe the eager
 * production registrations these tests audit. Vitest isolates modules per
 * file, so the registry here is the real one.
 */

import { describe, expect, it } from "vitest";
import "@/protocols";
import {
  clearEncodeTransforms,
  listEncodeTransforms,
  registerEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import { getProtocol, getRegisteredProtocols } from "@/lib/protocol-registry";

/**
 * weiToEther registered on a declared ABI input would diverge the runtime
 * from the emitted SDK: protocol-write.ts converts the value while the
 * synthesiser's weiToEther branch deliberately emits the raw expression.
 * The kind exists for the virtual ethValue field, which is not an ABI input.
 * Returns the offending registrations so the assertion can name them.
 */
function weiToEtherOnDeclaredAbiInputs(): string[] {
  const offenders: string[] = [];
  for (const t of listEncodeTransforms()) {
    if (t.kind !== "weiToEther") {
      continue;
    }
    const action = getProtocol(t.protocolSlug)?.actions.find(
      (a) => a.slug === t.actionSlug
    );
    if (action?.inputs.some((i) => i.name === t.inputName)) {
      offenders.push(`${t.protocolSlug}/${t.actionSlug}/${t.inputName}`);
    }
  }
  return offenders;
}

describe("encode transform registry invariants", () => {
  it("registers weiToEther only on virtual fields, never on an ABI input", () => {
    expect(weiToEtherOnDeclaredAbiInputs()).toEqual([]);
  });

  it("the check above actually catches a bad registration", () => {
    // Without this, the assertion above passes for as long as nobody
    // registers weiToEther at all, and would keep passing if the detector
    // itself broke. Pick a real action and a real declared input of it.
    const action = getRegisteredProtocols()
      .flatMap((p) => p.actions.map((a) => ({ slug: p.slug, action: a })))
      .find((x) => x.action.inputs.length > 0);
    expect(action, "registry has no action with inputs").toBeDefined();
    if (!action) {
      return;
    }
    const inputName = action.action.inputs[0].name;
    try {
      registerEncodeTransform(
        action.slug,
        action.action.slug,
        inputName,
        weiToEther,
        "weiToEther"
      );
      expect(weiToEtherOnDeclaredAbiInputs()).toContain(
        `${action.slug}/${action.action.slug}/${inputName}`
      );
    } finally {
      clearEncodeTransforms();
    }
  });
});

describe("protocol action lookup invariants", () => {
  it("no protocol has two actions sharing one (contract, function) pair", () => {
    // protocol-write.ts resolves the executing action with
    // `.find(a => a.function === fn && a.contract === key)`, and
    // protocol-derive.ts derives an action's slug from the function name,
    // so two overloads of one name on one contract would produce
    // indistinguishable actions and `.find` would silently take the first.
    // That used to decide only which ABI-arg transforms ran; since the
    // payable value is resolved through the same lookup it now decides
    // msg.value too, which makes the collision worth pinning rather than
    // leaving to convention.
    const collisions: string[] = [];
    for (const protocol of getRegisteredProtocols()) {
      const seen = new Set<string>();
      for (const a of protocol.actions) {
        const key = `${a.contract}.${a.function}`;
        if (seen.has(key)) {
          collisions.push(`${protocol.slug}: ${key}`);
        }
        seen.add(key);
      }
    }
    expect(collisions).toEqual([]);
  });
});

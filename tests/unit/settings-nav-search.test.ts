import { describe, expect, it } from "vitest";
import { findSettingsMatches } from "@/components/settings/hub/nav";

const OWNER = { isAdmin: true, isOwner: true };
const MEMBER = { isAdmin: false, isOwner: false };

/** Every card the query surfaced, as "Section > Card". */
function results(query: string, access = OWNER): string[] {
  return findSettingsMatches(query, access).flatMap((match) =>
    match.panels.map((panel) => `${match.item.label} > ${panel.title}`)
  );
}

describe("findSettingsMatches", () => {
  it("finds both the personal and the org side of a term", () => {
    expect(results("mfa")).toEqual([
      "Account security > Two-factor authentication",
      "Organization security > Organization MFA enforcement",
    ]);
  });

  it("matches a card by any of its other names", () => {
    for (const query of ["2fa", "totp", "authenticator", "backup codes"]) {
      expect(results(query)).toContain(
        "Account security > Two-factor authentication"
      );
    }
  });

  it("ignores the punctuation in a card's title", () => {
    expect(results("two factor")).toContain(
      "Account security > Two-factor authentication"
    );
  });

  it("matches whole words, so pin does not reach grouping", () => {
    expect(results("pin")).toEqual(["Account security > Wallet step-up"]);
  });

  it("lists everything in a section when the section itself is named", () => {
    expect(results("billing")).toEqual([
      "Billing > This month",
      "Billing > Pay as you go",
    ]);
  });

  it("leaves out sections the member cannot open", () => {
    expect(results("spend", MEMBER)).toEqual([]);
    expect(results("spend")).toEqual(["Spending limits > Daily value caps"]);
  });

  it("returns nothing for an empty or unmatched query", () => {
    expect(results("  ")).toEqual([]);
    expect(results("zzzz")).toEqual([]);
  });
});

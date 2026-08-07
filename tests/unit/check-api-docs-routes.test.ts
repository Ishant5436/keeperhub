import { describe, expect, it } from "vitest";
import {
  canonicalizeSamplePath,
  parseCodeSampleBlock,
  parseMarkdownEndpoints,
} from "../../scripts/check-api-docs-routes";

const SOURCE = "docs/api/fixture.md";

function page(...lines: string[]): string {
  return lines.join("\n");
}

describe("parseMarkdownEndpoints - http fences", () => {
  it("reads a fenced http block and reports a 1-based line number", () => {
    const text = page("# Keys", "", "```http", "POST /api/keys", "```");

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/keys",
        source: SOURCE,
        line: 4,
        format: "http-fence",
      },
    ]);
  });

  it("drops the query string from a fenced path", () => {
    const text = page("```http", "GET /api/runs?limit=10", "```");

    expect(parseMarkdownEndpoints(text, SOURCE)[0].path).toBe("/api/runs");
  });
});

describe("parseMarkdownEndpoints - inline code spans", () => {
  it("reads endpoints out of a markdown table cell", () => {
    const text = page(
      "| Step | Call |",
      "|---|---|",
      "| Sign in | `POST /api/auth/siwe/nonce`, then `POST /api/auth/siwe/verify` |",
      "| Find the wallet | `GET /api/user` -> `walletAddress` |"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/auth/siwe/nonce",
        source: SOURCE,
        line: 3,
        format: "inline-code",
      },
      {
        method: "POST",
        path: "/api/auth/siwe/verify",
        source: SOURCE,
        line: 3,
        format: "inline-code",
      },
      {
        method: "GET",
        path: "/api/user",
        source: SOURCE,
        line: 4,
        format: "inline-code",
      },
    ]);
  });

  it("reads an endpoint out of a prose sentence", () => {
    const text = "Call `POST /api/execute/transfer` with `simulate: true`.";

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/execute/transfer",
        source: SOURCE,
        line: 1,
        format: "inline-code",
      },
    ]);
  });

  it("ignores a docs-site link, which carries a path but no method", () => {
    const text = page(
      "See the [User API](/api/user) reference.",
      "See also [POST /api/keys](/api/keys) for keys."
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores a method and a path that sit in separate code spans", () => {
    const text = "Send `POST` to `/api/keys` to create a key.";

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores an unformatted mention in prose", () => {
    const text = "Older builds answered POST /api/keys/legacy with a 301.";

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });

  it("ignores an endpoint quoted inside a json sample", () => {
    // Verbatim from docs/api/index.md. /api/integrations/wallet has no
    // route file, so reading this hint as a declaration would fail CI.
    const text = page(
      "```json",
      "{",
      '  "error": "wallet_not_configured",',
      '  "hint": "POST /api/integrations/wallet to provision a wallet"',
      "}",
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });
});

describe("parseMarkdownEndpoints - code samples", () => {
  it("infers the method from the helper name, and reads a sample once", () => {
    // The comment holds a code span, which outside a fence would be read
    // as a second declaration of the same endpoint.
    const text = page(
      "```ts",
      "// `POST /api/keys` answers the first call with a challenge",
      'const key = await post("/api/keys", { name: "ci" });',
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/keys",
        source: SOURCE,
        line: 3,
        format: "code-sample",
      },
    ]);
  });

  it("infers the method from a method option when the helper is neutral", () => {
    const text = page(
      "```ts",
      'const res = await fetch("/api/execute/transfer", {',
      '  method: "POST",',
      "  headers,",
      "});",
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([
      {
        method: "POST",
        path: "/api/execute/transfer",
        source: SOURCE,
        line: 2,
        format: "code-sample",
      },
    ]);
  });

  it("falls back to GET when neither the helper nor the options name a method", () => {
    const text = page("```ts", 'const me = await api("/api/user");', "```");

    expect(parseMarkdownEndpoints(text, SOURCE)[0].method).toBe("GET");
  });

  it("names the path parameter after the last identifier of a template hole", () => {
    const text = page(
      "```ts",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the markdown fixture's content, not this file's
      "const status = await api(`/api/execute/${exec.executionId}/status`);",
      "```"
    );

    expect(parseMarkdownEndpoints(text, SOURCE)[0].path).toBe(
      "/api/execute/{executionId}/status"
    );
  });

  it("reads js fences as well as ts fences", () => {
    const text = page("```js", 'await del("/api/keys/{keyId}");', "```");

    expect(parseMarkdownEndpoints(text, SOURCE)[0].method).toBe("DELETE");
  });

  it("leaves a URL assembled from variables alone", () => {
    const text = page("```ts", "await fetch(BASE + path, { headers });", "```");

    expect(parseMarkdownEndpoints(text, SOURCE)).toEqual([]);
  });
});

describe("parseCodeSampleBlock", () => {
  it("offsets line numbers by the opening fence line", () => {
    const block = page("const a = 1;", 'await post("/api/keys");');

    expect(parseCodeSampleBlock(block, 10, SOURCE)[0].line).toBe(12);
  });

  it("does not carry one call's method over to the next call", () => {
    // The unclosed paren in the comment means the first call's argument
    // span never balances; without a ceiling it would run on into the
    // second call and pick up its method.
    const block = page(
      'const me = await api("/api/user", {',
      "  // the wrapper adds Authorization (and the org header",
      "  headers,",
      "});",
      'const key = await api("/api/keys", { method: "POST" });'
    );

    expect(
      parseCodeSampleBlock(block, 1, SOURCE).map((endpoint) => [
        endpoint.method,
        endpoint.path,
      ])
    ).toEqual([
      ["GET", "/api/user"],
      ["POST", "/api/keys"],
    ]);
  });

  it("is not confused by a paren inside a string argument", () => {
    const block = 'await api("/api/keys", { name: "ci (prod)" });';

    expect(parseCodeSampleBlock(block, 1, SOURCE)).toHaveLength(1);
  });
});

describe("canonicalizeSamplePath", () => {
  it("turns a template hole into a named parameter", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the docs sample's content, not this file's
    expect(canonicalizeSamplePath("/api/runs/${run.id}")).toBe(
      "/api/runs/{id}"
    );
  });

  it("strips the query string and a trailing slash", () => {
    expect(canonicalizeSamplePath("/api/runs/?limit=10")).toBe("/api/runs");
  });

  it("rejects a literal that is not shaped like a route", () => {
    expect(canonicalizeSamplePath("/api/keys - the key endpoint")).toBeNull();
  });
});

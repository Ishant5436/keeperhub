import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { checkCreditStep } from "@/plugins/agent-gateway/steps/check-credit";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("agent-gateway check-credit step", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it("refuses to call out when credentials are missing", async () => {
    const result = await checkCreditStep({ subOrgId: "", hmacSecret: "" });
    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("signs a GET request with the HMAC headers and returns the balance", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse(200, { amount: "0.50", currency: "USD", subOrgId: "su-1" })
    );

    const result = await checkCreditStep({
      subOrgId: "su-1",
      hmacSecret: "test-secret",
    });

    expect(result).toEqual({
      success: true,
      amount: "0.50",
      currency: "USD",
      subOrgId: "su-1",
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const [url, options] = safeFetch.mock.calls[0] as [
      string,
      {
        plugin?: string;
        method?: string;
        headers?: Record<string, string>;
      },
    ];
    expect(url).toContain("/api/agentic-wallet/credit");
    expect(options.plugin).toBe("agent-gateway");
    expect(options.method).toBe("GET");
    expect(options.headers?.["X-KH-Sub-Org"]).toBe("su-1");
    expect(options.headers?.["X-KH-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(options.headers?.["X-KH-Timestamp"]).toMatch(/^\d+$/);
  });

  it("surfaces a non-2xx response as a failed result instead of throwing", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse(404, { error: "Unknown sub-org", code: "WALLET_NOT_FOUND" })
    );

    const result = await checkCreditStep({
      subOrgId: "su-missing",
      hmacSecret: "test-secret",
    });

    expect(result).toEqual({
      success: false,
      error: "Unknown sub-org",
      code: "WALLET_NOT_FOUND",
    });
  });
});

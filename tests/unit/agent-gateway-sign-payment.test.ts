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

import { signPaymentStep } from "@/plugins/agent-gateway/steps/sign-payment";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const baseInput = {
  subOrgId: "su-1",
  hmacSecret: "test-secret",
  chain: "base" as const,
  paymentChallenge: { payTo: "0xabc", amount: "500000", nonce: "0x01" },
};

describe("agent-gateway sign-payment step", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it("does not auto-retry", () => {
    expect(signPaymentStep.maxRetries).toBe(0);
  });

  it("returns status=signed on a 200 with a signature", async () => {
    safeFetch.mockResolvedValue(jsonResponse(200, { signature: "0xdeadbeef" }));

    const result = await signPaymentStep(baseInput);

    expect(result).toEqual({
      success: true,
      status: "signed",
      signature: "0xdeadbeef",
    });

    const [, options] = safeFetch.mock.calls[0] as [
      string,
      { method?: string },
    ];
    expect(options.method).toBe("POST");
  });

  it("returns status=pending_approval on a 202", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse(202, { approvalRequestId: "areq-1" })
    );

    const result = await signPaymentStep(baseInput);

    expect(result).toEqual({
      success: true,
      status: "pending_approval",
      approvalRequestId: "areq-1",
    });
  });

  it("returns status=blocked (not a thrown error) on a 403", async () => {
    safeFetch.mockResolvedValue(
      jsonResponse(403, {
        error: "Risk threshold exceeded",
        code: "RISK_BLOCKED",
      })
    );

    const result = await signPaymentStep(baseInput);

    expect(result).toEqual({
      success: false,
      status: "blocked",
      error: "Risk threshold exceeded",
      code: "RISK_BLOCKED",
    });
  });

  it("rejects a missing paymentChallenge before ever calling out", async () => {
    const result = await signPaymentStep({
      subOrgId: "su-1",
      hmacSecret: "test-secret",
      chain: "base",
      paymentChallenge: undefined,
    });

    expect(result.success).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

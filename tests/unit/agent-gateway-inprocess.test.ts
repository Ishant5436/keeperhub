import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockDbSelect = vi.fn();
const mockDbFrom = vi.fn();
const mockDbWhere = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => {
      mockDbSelect(...args);
      return {
        from: (...fromArgs: unknown[]) => {
          mockDbFrom(...fromArgs);
          return {
            where: (...whereArgs: unknown[]) => mockDbWhere(...whereArgs),
          };
        },
      };
    },
  },
}));

const mockVerifyWorkflowBinding = vi.fn();
vi.mock("@/lib/agentic-wallet/workflow-binding", () => ({
  verifyWorkflowBinding: (...args: unknown[]) =>
    mockVerifyWorkflowBinding(...args),
}));

const mockClassifyRisk = vi.fn();
vi.mock("@/lib/agentic-wallet/risk", () => ({
  classifyRisk: (...args: unknown[]) => mockClassifyRisk(...args),
}));

const mockReserveSpend = vi.fn();
const mockRollbackSpend = vi.fn();
vi.mock("@/lib/agentic-wallet/daily-spend", () => ({
  reserveSpend: (...args: unknown[]) => mockReserveSpend(...args),
  rollbackSpend: (...args: unknown[]) => mockRollbackSpend(...args),
}));

const mockSignX402Challenge = vi.fn();
const mockSignMppTransaction = vi.fn();
const mockSignMppProof = vi.fn();
vi.mock("@/lib/agentic-wallet/sign", () => ({
  signX402Challenge: (...args: unknown[]) => mockSignX402Challenge(...args),
  signMppTransaction: (...args: unknown[]) => mockSignMppTransaction(...args),
  signMppProof: (...args: unknown[]) => mockSignMppProof(...args),
  PolicyBlockedError: class PolicyBlockedError extends Error {},
  TurnkeyUpstreamError: class TurnkeyUpstreamError extends Error {},
}));

const mockCreateApprovalRequest = vi.fn();
const mockDeriveApprovalBinding = vi.fn();
vi.mock("@/lib/agentic-wallet/approval", () => ({
  createApprovalRequest: (...args: unknown[]) =>
    mockCreateApprovalRequest(...args),
  deriveApprovalBinding: (...args: unknown[]) =>
    mockDeriveApprovalBinding(...args),
}));

const mockRecordAuditEvent = vi.fn();
vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent: (...args: unknown[]) => mockRecordAuditEvent(...args),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import {
  checkCreditInProcess,
  signPaymentInProcess,
} from "@/plugins/agent-gateway/steps/inprocess-core";

describe("agent-gateway in-process execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkCreditInProcess", () => {
    it("fails when subOrgId is empty", async () => {
      const result = await checkCreditInProcess("");
      expect(result.success).toBe(false);
      expect(result.error).toBe("subOrgId is required");
    });

    it("queries database and returns balance in USD", async () => {
      mockDbWhere.mockResolvedValueOnce([{ totalCents: "2550" }]);

      const result = await checkCreditInProcess("su-test");

      expect(result).toEqual({
        success: true,
        amount: "25.50",
        currency: "USD",
        subOrgId: "su-test",
      });
      expect(mockDbSelect).toHaveBeenCalledTimes(1);
    });

    it("handles db query failure gracefully", async () => {
      mockDbWhere.mockRejectedValueOnce(new Error("Connection reset"));

      const result = await checkCreditInProcess("su-test");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection reset");
    });
  });

  describe("signPaymentInProcess", () => {
    const baseInput = {
      chain: "base" as const,
      workflowSlug: "demo-slug",
      paymentChallenge: { payTo: "0x123", amount: "500000" },
    };

    it("fails when workflowSlug is missing", async () => {
      const result = await signPaymentInProcess(
        { ...baseInput, workflowSlug: "" },
        "su-test"
      );
      expect(result).toMatchObject({
        success: false,
        status: "error",
        code: "WORKFLOW_SLUG_REQUIRED",
      });
    });

    it("fails when wallet does not exist for subOrgId", async () => {
      mockDbWhere.mockResolvedValueOnce([]);

      const result = await signPaymentInProcess(baseInput, "su-test");

      expect(result).toMatchObject({
        success: false,
        status: "error",
        code: "WALLET_NOT_FOUND",
      });
    });

    it("returns blocked when workflow binding fails", async () => {
      mockDbWhere.mockResolvedValueOnce([
        { walletAddressBase: "0xbase", walletAddressTempo: null },
      ]);
      mockVerifyWorkflowBinding.mockResolvedValueOnce({
        ok: false,
        code: "PAYTO_MISMATCH",
        error: "Payee mismatch",
      });

      const result = await signPaymentInProcess(baseInput, "su-test");

      expect(result).toMatchObject({
        success: false,
        status: "blocked",
        code: "PAYTO_MISMATCH",
      });
    });

    it("successfully signs Base x402 challenge in-process", async () => {
      mockDbWhere.mockResolvedValueOnce([
        { walletAddressBase: "0xbase", walletAddressTempo: null },
      ]);
      mockVerifyWorkflowBinding.mockResolvedValueOnce({
        ok: true,
        expectedPayTo: "0x123",
        expectedAmountMicro: "500000",
        workflowId: "wf-1",
      });
      mockClassifyRisk.mockReturnValueOnce("auto");
      mockReserveSpend.mockResolvedValueOnce({ ok: true });
      mockSignX402Challenge.mockResolvedValueOnce("0xsignature123");

      const result = await signPaymentInProcess(baseInput, "su-test");

      expect(result).toEqual({
        success: true,
        status: "signed",
        signature: "0xsignature123",
      });
      expect(mockSignX402Challenge).toHaveBeenCalledTimes(1);
      expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1);
    });
  });
});

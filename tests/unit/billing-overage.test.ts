import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockFindFirstSub = vi.fn();
const mockFindFirstOverage = vi.fn();
const mockInsertValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizationSubscriptions: {
        findFirst: (...args: unknown[]) => mockFindFirstSub(...args),
      },
      overageBillingRecords: {
        findFirst: (...args: unknown[]) => mockFindFirstOverage(...args),
      },
    },
    execute: vi.fn(),
    insert: vi.fn(() => ({
      values: mockInsertValues,
    })),
    update: vi.fn(() => ({
      set: mockUpdateSet,
    })),
  },
}));

vi.mock("@/lib/billing/providers", () => ({
  getBillingProvider: vi.fn(),
}));

import { billOverageForOrg } from "@/lib/billing/overage";
import type { BillingProvider } from "@/lib/billing/provider";
import { getBillingProvider } from "@/lib/billing/providers";
import { db } from "@/lib/db";

function mockExecutionCount(count: number): void {
  vi.mocked(db.execute).mockResolvedValue([{ count }] as unknown as Awaited<
    ReturnType<typeof db.execute>
  >);
}

function mockBillingProvider(overrides: Partial<BillingProvider>): void {
  vi.mocked(getBillingProvider).mockReturnValue(overrides as BillingProvider);
}

const periodStart = new Date("2025-01-01");
const periodEnd = new Date("2025-02-01");

beforeEach(() => {
  vi.clearAllMocks();

  mockInsertValues.mockReturnValue({
    onConflictDoNothing: mockOnConflictDoNothing,
  });
  mockOnConflictDoNothing.mockReturnValue({
    returning: mockReturning,
  });
  mockUpdateSet.mockReturnValue({
    where: mockUpdateWhere,
  });
  mockUpdateWhere.mockResolvedValue(undefined);
});

describe("billOverageForOrg", () => {
  it("skips when no subscription exists", async () => {
    mockFindFirstSub.mockResolvedValue(undefined);

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({ billed: false, reason: "no subscription" });
  });

  it("skips when overage is not enabled (free plan)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "free",
      tier: null,
      status: "active",
      providerCustomerId: "cus_123",
    });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "overage not enabled for plan",
    });
  });

  it("skips when no provider customer ID", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: null,
    });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "no provider customer ID",
    });
  });

  it("skips when unlimited plan (enterprise)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "enterprise",
      tier: null,
      status: "active",
      providerCustomerId: "cus_123",
    });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "overage not enabled for plan",
    });
  });

  it("skips when already billed for this period (idempotency)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue({ id: "existing_record" });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "already billed for this period",
    });
  });

  it("skips when no overage (usage under limit)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(20_000);

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({ billed: false, reason: "no overage" });
  });

  it("bills overage and creates Stripe invoice item", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockResolvedValue({ invoiceItemId: "ii_123" });
    mockBillingProvider({ createInvoiceItem: mockCreateInvoiceItem });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: true,
      overageCount: 1500,
      totalChargeCents: 300,
    });
    expect(mockCreateInvoiceItem).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_123",
        amount: 300,
        currency: "usd",
      })
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "billed",
        providerInvoiceItemId: "ii_123",
      })
    );
  });

  it("marks record as failed when provider throws", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(30_000);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    vi.mocked(getBillingProvider).mockReturnValue({
      createInvoiceItem: vi
        .fn()
        .mockRejectedValue(new Error("Stripe API error")),
    } as unknown as ReturnType<typeof getBillingProvider>);

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "provider error: Stripe API error",
    });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });

  it("handles race condition on insert (conflict = already billed)", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(30_000);
    // onConflictDoNothing returns empty array (conflict)
    mockReturning.mockResolvedValue([]);

    const result = await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(result).toEqual({
      billed: false,
      reason: "already billed for this period",
    });
    expect(getBillingProvider).not.toHaveBeenCalled();
  });

  it("attaches the charge to the closing invoice when one is given", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockResolvedValue({ invoiceItemId: "ii_123" });
    mockBillingProvider({ createInvoiceItem: mockCreateInvoiceItem });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd, {
      invoiceId: "in_closing",
    });

    expect(result).toEqual({
      billed: true,
      overageCount: 1500,
      totalChargeCents: 300,
    });
    expect(mockCreateInvoiceItem).toHaveBeenCalledTimes(1);
    expect(mockCreateInvoiceItem).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_closing" })
    );
  });

  it("retries unattached when the closing invoice can no longer take the item", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invoice is no longer editable"))
      .mockResolvedValueOnce({ invoiceItemId: "ii_pending" });
    mockBillingProvider({ createInvoiceItem: mockCreateInvoiceItem });

    const result = await billOverageForOrg("org_1", periodStart, periodEnd, {
      invoiceId: "in_closing",
    });

    expect(result).toEqual({
      billed: true,
      overageCount: 1500,
      totalChargeCents: 300,
    });
    expect(mockCreateInvoiceItem).toHaveBeenCalledTimes(2);
    expect(mockCreateInvoiceItem).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ invoiceId: expect.anything() })
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "billed",
        providerInvoiceItemId: "ii_pending",
      })
    );
  });

  it("leaves the item unattached when no closing invoice is given", async () => {
    mockFindFirstSub.mockResolvedValue({
      plan: "pro",
      tier: "25k",
      status: "active",
      providerCustomerId: "cus_123",
    });
    mockFindFirstOverage.mockResolvedValue(undefined);
    mockExecutionCount(26_500);
    mockReturning.mockResolvedValue([{ id: "rec_1" }]);

    const mockCreateInvoiceItem = vi
      .fn()
      .mockResolvedValue({ invoiceItemId: "ii_123" });
    mockBillingProvider({ createInvoiceItem: mockCreateInvoiceItem });

    await billOverageForOrg("org_1", periodStart, periodEnd);

    expect(mockCreateInvoiceItem).toHaveBeenCalledWith(
      expect.not.objectContaining({ invoiceId: expect.anything() })
    );
  });
});

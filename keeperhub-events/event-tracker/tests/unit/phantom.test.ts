import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/utils/logger", () => ({
  logger: { warn: vi.fn(), log: vi.fn() },
}));

// HMAC signing reads INTERNAL_SERVICE_HMAC_SECRET and parses the request URL;
// stub it so the unit test asserts the request shape without a real base
// URL/secret.
vi.mock("../../lib/utils/fetch-utils", () => ({
  // Plain function (not vi.fn) so restoreAllMocks in beforeEach can't neutralise it.
  signHmacHeaders: () => ({
    "X-KH-Caller": "events",
    "X-KH-Timestamp": "1",
    "X-KH-Signature": "sig",
  }),
}));

import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom";

describe("createPhantomExecution (event-tracker)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs a phantom row and returns the execution id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ executionId: "exec_evt" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPhantomExecution("wf_1", "owner_1");

    expect(result).toEqual({ executionId: "exec_evt" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/internal\/executions$/);
    expect(init.method).toBe("POST");
    expect(init.headers["X-KH-Caller"]).toBe("events");
    expect(JSON.parse(init.body)).toEqual({
      workflowId: "wf_1",
      userId: "owner_1",
      status: "phantom",
      triggerSource: "event",
    });
  });

  it("returns no id and no refusal on a non-2xx response (best-effort)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    await expect(createPhantomExecution("wf_1", "owner_1")).resolves.toEqual(
      {},
    );
  });

  it("returns no id and no refusal when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    await expect(createPhantomExecution("wf_1", "owner_1")).resolves.toEqual(
      {},
    );
  });

  // A transport failure and a refusal must stay distinguishable: the first
  // still falls back to the id-less enqueue, the second must not enqueue.
  it("reports a refusal instead of an id when the platform declines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          refused: true,
          reason: "execution_limit",
          error: "limit reached",
        }),
      }),
    );

    await expect(createPhantomExecution("wf_1", "owner_1")).resolves.toEqual({
      refused: "execution_limit",
    });
  });
});

describe("failPhantomExecution (event-tracker)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the phantom row to a coded error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await failPhantomExecution("exec_evt", "ES-0001", "dispatch failed");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/internal\/executions\/exec_evt$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      status: "system_error",
      error: "dispatch failed",
      errorCode: "ES-0001",
    });
  });

  it("swallows errors (the reaper is the backstop)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    await expect(
      failPhantomExecution("exec_evt", "ES-0001", "x"),
    ).resolves.toBeUndefined();
  });
});

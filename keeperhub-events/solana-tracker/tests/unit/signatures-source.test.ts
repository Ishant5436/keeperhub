import { afterEach, describe, expect, it, vi } from "vitest";

type SignatureInfo = { signature: string; slot: number };
type SignatureQuery = { until?: string; before?: string; limit?: number };

// Controllable stand-in for the per-chain Solana connection so the source's
// poll cadence and paging can be driven deterministically without any network.
const hooks = vi.hoisted(() => ({
  onSlot: null as null | ((slot: number) => void),
  signatureCalls: [] as { address: string; until?: string; before?: string }[],
  signatures: (
    _address: string,
    _options: { until?: string; before?: string; limit?: number },
  ): { signature: string; slot: number }[] => [],
  // Simulates a poll slower than the interval. Resolved by fake timers.
  delayMs: 0,
}));

vi.mock("@/src/ingest/solana-connection", () => ({
  SolanaConnection: class {
    constructor(opts: { onSlot: (slot: number) => void }) {
      hooks.onSlot = opts.onSlot;
    }
    start(): void {
      /* no-op mock */
    }
    stop(): Promise<void> {
      return Promise.resolve();
    }
    getSignaturesForAddress(
      address: string,
      options: SignatureQuery,
    ): Promise<unknown[]> {
      hooks.signatureCalls.push({
        address,
        until: options.until,
        before: options.before,
      });
      const result = hooks.signatures(address, options);
      if (hooks.delayMs === 0) {
        return Promise.resolve(result);
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(result), hooks.delayMs);
      });
    }
    getTransaction(): Promise<unknown> {
      return Promise.resolve({ meta: { logMessages: [] }, blockTime: 0 });
    }
    getHealth(): unknown {
      return {};
    }
  },
}));

const { SignaturesSource } = await import("@/src/ingest/signatures-source");

const PROGRAM = "So11111111111111111111111111111111111111112";
const POLL_INTERVAL_MS = 1000;
const PAGE_SIZE = 1000;

function source(
  onBlock: () => Promise<void> = () => Promise.resolve(),
): InstanceType<typeof SignaturesSource> {
  return new SignaturesSource(
    {
      chainId: 101,
      endpoints: [{ rpcUrl: "r", wssUrl: "w" }],
      commitment: "confirmed",
      watchedProgramIds: [PROGRAM],
      onBlock,
    },
    POLL_INTERVAL_MS,
  );
}

function page(prefix: string, count: number): SignatureInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    signature: `${prefix}-${i}`,
    slot: i,
  }));
}

afterEach(() => {
  vi.useRealTimers();
  hooks.signatureCalls = [];
  hooks.signatures = () => [];
  hooks.delayMs = 0;
});

describe("SignaturesSource poll throttle", () => {
  it("coalesces a burst of slot ticks into one deferred poll", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    // start() seeds one cursor per watched program.
    expect(hooks.signatureCalls).toHaveLength(1);

    hooks.signatures = () => [];

    // Solana mainnet delivers ~2.5 slot ticks/s. Honouring each one would issue
    // a query per program per tick; they must collapse to one poll instead.
    for (let slot = 1; slot <= 5; slot++) {
      hooks.onSlot?.(slot);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(2);

    // The ticks that arrived inside the interval are not dropped - they fire as
    // a single poll once the interval elapses.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(hooks.signatureCalls).toHaveLength(3);

    // With no further ticks the source goes quiet rather than free-running.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(hooks.signatureCalls).toHaveLength(3);

    await src.stop();
  });

  it("still waits a full interval after a poll that outlasts the interval", async () => {
    // Regression guard: measuring the interval from poll start leaves the guard
    // already satisfied when a slow poll returns, so the source free-runs on
    // exactly the busy chains the floor protects.
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    hooks.signatures = () => [];
    hooks.delayMs = POLL_INTERVAL_MS * 3;

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(hooks.signatureCalls).toHaveLength(2);

    hooks.onSlot?.(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(hooks.signatureCalls).toHaveLength(3);

    await src.stop();
  });

  it("polls immediately when a tick arrives after the interval has elapsed", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    hooks.signatures = () => [];

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    hooks.onSlot?.(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.signatureCalls).toHaveLength(3);

    await src.stop();
  });

  it("cancels a deferred poll on stop", async () => {
    vi.useFakeTimers();
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];

    const src = source();
    await src.start();
    hooks.signatures = () => [];

    hooks.onSlot?.(1);
    await vi.advanceTimersByTimeAsync(0);
    hooks.onSlot?.(2); // deferred to the interval boundary
    const callsBeforeStop = hooks.signatureCalls.length;

    await src.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(hooks.signatureCalls).toHaveLength(callsBeforeStop);

    await src.stop();
  });
});

describe("SignaturesSource windowing", () => {
  it("pages backwards instead of skipping past a full response", async () => {
    // A full page means the window is not exhausted. Advancing the cursor to
    // the newest signature at that point drops everything older, permanently.
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];
    let processed = 0;
    const src = source(() => {
      processed++;
      return Promise.resolve();
    });
    await src.start();

    const first = page("new", PAGE_SIZE);
    const second = page("old", 3);
    hooks.signatures = (_address, options) =>
      options.before === undefined ? first : second;

    hooks.onSlot?.(1);
    await vi.waitFor(() => expect(processed).toBe(PAGE_SIZE + second.length));

    const pollCalls = hooks.signatureCalls.slice(1);
    expect(pollCalls).toHaveLength(2);
    expect(pollCalls[0].before).toBeUndefined();
    // Second page continues from the oldest signature of the first.
    expect(pollCalls[1].before).toBe(`new-${PAGE_SIZE - 1}`);
    expect(pollCalls[1].until).toBe("seed-sig");

    await src.stop();
  });

  it("stops paging once a short page shows the window is exhausted", async () => {
    hooks.signatures = () => [{ signature: "seed-sig", slot: 1 }];
    let processed = 0;
    const src = source(() => {
      processed++;
      return Promise.resolve();
    });
    await src.start();

    hooks.signatures = () => page("new", 2);

    hooks.onSlot?.(1);
    await vi.waitFor(() => expect(processed).toBe(2));
    expect(hooks.signatureCalls.slice(1)).toHaveLength(1);

    await src.stop();
  });
});

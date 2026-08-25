// KEEP-581: pre-save schedule-interval validation on PATCH
// /api/workflows/[workflowId]. The route now runs extractScheduleConfig
// against body.nodes before the DB update so sub-60s intervals never
// land as persisted nodes paired with a missing or miscadenced schedule
// row. Other sync failures (bad timezone, invalid cron) still take the
// warn-and-continue path inside handlePostUpdateSideEffects.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The route records a workflow snapshot, pulling in history -> version-diff ->
// step-registry, which `import "server-only"`. Stub the guard for vitest.
vi.mock("server-only", () => ({}));

const {
  mockGetDualAuthContext,
  mockWorkflowsFindFirst,
  mockUpdateReturning,
  mockSelectFrom,
  mockMemberLimit,
  mockValidateWorkflowIntegrations,
  mockSyncWorkflowSchedule,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockWorkflowsFindFirst: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockMemberLimit: vi.fn(),
  mockValidateWorkflowIntegrations: vi.fn(),
  mockSyncWorkflowSchedule: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: {
        findFirst: mockWorkflowsFindFirst,
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockUpdateReturning,
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn((...args) => {
            const p = mockSelectFrom(...args);
            return Object.assign(p, { limit: mockMemberLimit });
          }),
        })),
        where: vi.fn(() => ({
          limit: mockMemberLimit,
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: { id: "id" },
  workflowPublicTags: {
    workflowId: "workflow_id",
    publicTagId: "public_tag_id",
  },
  publicTags: { id: "id", name: "name", slug: "slug" },
  member: { id: "id", organizationId: "organization_id", userId: "user_id" },
  users: { id: "id", deactivatedAt: "deactivated_at" },
  projects: { id: "id", organizationId: "organization_id" },
  tags: { id: "id", organizationId: "organization_id" },
  workflowExecutions: { workflowId: "workflow_id" },
  workflowSchedules: { workflowId: "workflow_id" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: mockValidateWorkflowIntegrations,
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

// Only the side-effect sync is mocked; extractScheduleConfig is exercised
// for real so the pre-check path runs the actual parseIntervalSeconds
// guard from cron-utils.
vi.mock("@/lib/schedule-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schedule-service")>(
    "@/lib/schedule-service"
  );
  return {
    ...actual,
    syncWorkflowSchedule: mockSyncWorkflowSchedule,
  };
});

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: vi.fn((raw: string) => `SANITIZED:${raw}`),
}));

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

import { PATCH } from "@/app/api/workflows/[workflowId]/route";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/workflows/wf-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ workflowId: "wf-1" });

function scheduleTriggerNode(
  scheduleIntervalSeconds: number | string | null
): Record<string, unknown> {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      type: "trigger",
      label: "Schedule",
      config: {
        triggerType: "Schedule",
        scheduleIntervalSeconds,
        scheduleTimezone: "UTC",
        scheduleCron: "0 9 * * *",
      },
    },
  };
}

// KEEP-1216: the shape the public API docs show - outer `type: "trigger"`,
// no `data.type`. Only the sanitizer writes `data.type`, and
// extractScheduleConfig keys on it, so this is the shape that exposes any
// place the route still reads the raw request body.
function docsShapedScheduleNode(
  config: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Schedule",
      config: { triggerType: "Schedule", scheduleTimezone: "UTC", ...config },
    },
  };
}

function existingWorkflow(): Record<string, unknown> {
  return {
    id: "wf-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "wf",
    description: "",
    nodes: [],
    edges: [],
    visibility: "private",
    isAnonymous: false,
    enabled: true,
    projectId: null,
    tagId: null,
    isListed: false,
    listedSlug: null,
    listedAt: null,
    inputSchema: null,
    outputMapping: null,
    priceUsdcPerCall: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("KEEP-581: PATCH /api/workflows/[workflowId] schedule interval guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    mockWorkflowsFindFirst.mockResolvedValue(existingWorkflow());
    mockSelectFrom.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "m-1" }]);
    mockSyncWorkflowSchedule.mockResolvedValue({ synced: true });
    mockUpdateReturning.mockResolvedValue([existingWorkflow()]);
  });

  it("returns 400 with SCHEDULE_INTERVAL_TOO_SMALL when scheduleIntervalSeconds is 30", async () => {
    const response = await PATCH(
      makeRequest({ nodes: [scheduleTriggerNode(30)] }),
      { params }
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("SCHEDULE_INTERVAL_TOO_SMALL");
    expect(body.message).toContain(">= 60");
  });

  it("returns 400 at the boundary just below the floor (59)", async () => {
    const response = await PATCH(
      makeRequest({ nodes: [scheduleTriggerNode(59)] }),
      { params }
    );

    expect(response.status).toBe(400);
  });

  it("does not call syncWorkflowSchedule when the pre-check rejects (no partial write)", async () => {
    await PATCH(makeRequest({ nodes: [scheduleTriggerNode(15)] }), { params });

    expect(mockSyncWorkflowSchedule).not.toHaveBeenCalled();
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("accepts scheduleIntervalSeconds at the exact floor (60)", async () => {
    const response = await PATCH(
      makeRequest({ nodes: [scheduleTriggerNode(60)] }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(mockSyncWorkflowSchedule).toHaveBeenCalledTimes(1);
  });

  it("accepts a workflow with no schedule trigger (manual)", async () => {
    const manualTrigger = {
      id: "trigger-1",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        type: "trigger",
        label: "Manual",
        config: { triggerType: "Manual" },
      },
    };

    const response = await PATCH(makeRequest({ nodes: [manualTrigger] }), {
      params,
    });

    expect(response.status).toBe(200);
  });
});

// KEEP-1216: PATCH persists the sanitized nodes but used to sync the schedule
// from the raw body. A docs-shaped trigger therefore resolved to "no schedule
// trigger", which takes the delete branch in syncWorkflowSchedule and silently
// removed the row - returning {synced:true}, so not even a warning. Harmless
// while create never registered a schedule; destructive once it does.
describe("KEEP-1216: PATCH syncs from the sanitized nodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      authMethod: "session",
    });
    mockValidateWorkflowIntegrations.mockResolvedValue({ valid: true });
    mockWorkflowsFindFirst.mockResolvedValue(existingWorkflow());
    mockSelectFrom.mockResolvedValue([]);
    mockMemberLimit.mockResolvedValue([{ id: "m-1" }]);
    mockSyncWorkflowSchedule.mockResolvedValue({ synced: true });
    mockUpdateReturning.mockResolvedValue([existingWorkflow()]);
  });

  it("syncs a docs-shaped Schedule trigger instead of erasing it", async () => {
    const response = await PATCH(
      makeRequest({
        nodes: [docsShapedScheduleNode({ scheduleCron: "0 9 * * *" })],
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(mockSyncWorkflowSchedule).toHaveBeenCalledTimes(1);

    // The nodes handed to the sync must carry data.type, which is what makes
    // extractScheduleConfig resolve the trigger rather than return null.
    const [, syncedNodes] = mockSyncWorkflowSchedule.mock.calls[0];
    expect(syncedNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            type: "trigger",
            config: expect.objectContaining({
              triggerType: "Schedule",
              scheduleCron: "0 9 * * *",
            }),
          }),
        }),
      ])
    );
  });

  it("rejects a docs-shaped sub-minute interval with 400", async () => {
    const response = await PATCH(
      makeRequest({
        nodes: [docsShapedScheduleNode({ scheduleIntervalSeconds: 30 })],
      }),
      { params }
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("SCHEDULE_INTERVAL_TOO_SMALL");
    expect(mockSyncWorkflowSchedule).not.toHaveBeenCalled();
    expect(mockUpdateReturning).not.toHaveBeenCalled();
  });

  it("still passes sanitized nodes when the trigger already carries data.type", async () => {
    const response = await PATCH(
      makeRequest({ nodes: [scheduleTriggerNode(null)] }),
      { params }
    );

    expect(response.status).toBe(200);
    const [, syncedNodes] = mockSyncWorkflowSchedule.mock.calls[0];
    expect(syncedNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ type: "trigger" }),
        }),
      ])
    );
  });
});

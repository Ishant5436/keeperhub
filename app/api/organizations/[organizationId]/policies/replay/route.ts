import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import type { PolicyDocument } from "@/lib/policy";
import { replayDecisions } from "@/lib/policy/replay";
import { requireOrgPolicyAccess } from "../_lib/access";

/** Longest window replay will look back over, in days. */
const MAX_WINDOW_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 7;

function clampWindow(value: unknown): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) {
    return DEFAULT_WINDOW_DAYS;
  }
  return Math.min(Math.floor(days), MAX_WINDOW_DAYS);
}

/**
 * What would change if this policy were saved.
 *
 * Re-decides recorded decisions against a candidate document that need not
 * exist yet. Nothing is charged against any limit and nothing is written: the
 * evaluator is pure, and replay deliberately never reaches the ledger.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "read");
  if (!access.ok) {
    return access.response;
  }

  try {
    const body = (await request.json()) as {
      document?: PolicyDocument;
      windowDays?: number;
    };

    if (!body.document) {
      return NextResponse.json(
        { error: "A policy document is required" },
        { status: 400 }
      );
    }

    const result = await replayDecisions({
      organizationId,
      document: body.document,
      windowDays: clampWindow(body.windowDays),
    });

    return NextResponse.json(result);
  } catch (error) {
    return apiError(error, "Failed to replay decisions");
  }
}

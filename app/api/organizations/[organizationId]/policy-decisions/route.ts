import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { policyDecisions } from "@/lib/db/schema";
import { PolicyOutcome } from "@/lib/policy";
import { requireOrgPolicyAccess } from "../policies/_lib/access";

/**
 * The decision log.
 *
 * This is what makes monitor mode worth anything: it shows what a policy would
 * have blocked before anyone turns enforcement on, and afterwards it answers
 * "why did this stop" without reading execution logs.
 *
 * Unmanaged decisions are never written, so this is already the governed subset
 * rather than a firehose.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "read");
  if (!access.ok) {
    return access.response;
  }

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const outcome = url.searchParams.get("outcome");

  try {
    const conditions = [eq(policyDecisions.organizationId, organizationId)];
    if (outcome && Object.values(PolicyOutcome).includes(outcome as never)) {
      conditions.push(eq(policyDecisions.outcome, outcome as PolicyOutcome));
    }

    const rows = await db
      .select({
        id: policyDecisions.id,
        checkpoint: policyDecisions.checkpoint,
        capability: policyDecisions.capability,
        resource: policyDecisions.resource,
        outcome: policyDecisions.outcome,
        reason: policyDecisions.reason,
        matchedSids: policyDecisions.matchedSids,
        observedOnly: policyDecisions.observedOnly,
        principalKind: policyDecisions.principalKind,
        executionId: policyDecisions.executionId,
        workflowId: policyDecisions.workflowId,
        createdAt: policyDecisions.createdAt,
      })
      .from(policyDecisions)
      .where(and(...conditions))
      .orderBy(desc(policyDecisions.createdAt))
      .limit(limit);

    // An explicit projection rather than the whole row: the stored facts and
    // signals are for the engine, and this endpoint is read by anyone who can
    // see policy.
    return NextResponse.json({ decisions: rows });
  } catch (error) {
    return apiError(error, "Failed to read policy decisions");
  }
}

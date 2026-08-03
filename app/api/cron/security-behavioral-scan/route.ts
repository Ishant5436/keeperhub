/**
 * KEEP-612 behavioral detection cron. Periodic queries against the
 * attribution columns added in migration 0088 (workflow_executions.user_id,
 * started_at, triggered_by_org_api_key_id, triggered_by_country) plus the
 * users table to surface signals that grafana/prometheus can't compute
 * because the substrate lives in Postgres, not the metrics pipeline.
 *
 * Emits structured `security.behavioral.*` log lines that the Loki alert
 * rules in `techops_infrastructure/keeperhub-security-alerts.tf` key off.
 * One log line per detected event so triage can pivot by user/key without
 * having to re-run the query.
 *
 * Deployment: invoked by a Kubernetes CronJob every 5 minutes (the
 * `security-behavioral-scan` job in `deploy/keeperhub-stack/{prod,staging}/
 * values.yaml`, which runs `deploy/scripts/reaper.sh` against this path).
 * Authorized via the internal-service HMAC scheme (`X-KH-Caller`,
 * `X-KH-Timestamp`, `X-KH-Signature` signed with
 * `INTERNAL_SERVICE_HMAC_SECRET`) through `authenticateInternalService`,
 * the same mechanism the reaper CronJob uses -- so scheduling reuses the
 * existing shared signing secret rather than provisioning a dedicated cron
 * secret. The endpoint fails closed when the signature does not verify;
 * there is no NODE_ENV dev/test bypass, so a prod container that boots with
 * `NODE_ENV=test` (the misconfig the v2 review flagged) cannot accidentally
 * open the endpoint. Local dev signs with `INTERNAL_SERVICE_HMAC_SECRET`
 * (see `deploy/scripts/reaper.sh`) to invoke via curl.
 *
 * Detection windows are deliberately overlapping so a transient blip in
 * scheduler timing doesn't drop an event: the CronJob fires every 5
 * minutes but EXECUTION_LOOKBACK_MS is 10 minutes, so every execution is
 * read by two consecutive scans and a single late/skipped run still
 * leaves it covered. The duplicate emissions do NOT collapse downstream,
 * contrary to what this comment used to claim. The Loki module builds
 * `sum by (pod) (count_over_time({...} |~ "<substring>" [1m]))` on a 60s
 * evaluation interval, so the rule's effective counting window is 1
 * minute regardless of the 600s `relative_time_range` (which only sets
 * the instant query's time envelope, and which the alert annotation text
 * misreports as the window). Two emissions 5 minutes apart therefore
 * always fire, resolve, and fire again as separate PagerDuty incidents.
 * Grouping by `pod` compounds it -- consecutive scans hit different
 * replicas, so they are not even the same alert series -- but the 1m
 * window alone guarantees the re-fire. Both are hardcoded in the module
 * (`SkyEcosystem/loki-grafana-alert`) with no variable to override, so
 * closing this needs a change there, not here. Sentry dedupes correctly
 * via the executionId fingerprint below; PagerDuty does not.
 *
 * Tiering. Account age alone is not evidence of anything -- signing up
 * and immediately running something is what the product's own onboarding
 * tour instructs people to do, and on 60 days of prod it accounted for
 * the large majority of matches. Every row is still scanned and still
 * emitted, but only rows carrying evidence the actor actually produced
 * are emitted under the paging event name:
 *
 *   - `behavioral.new_account_first_workflow`   (evidence present -> pages)
 *   - `behavioral.new_account_routine_execution` (no evidence -> dashboard only)
 *
 * The Loki module matches a SUBSTRING of the log line, so the paging name
 * is kept byte-identical to what the existing rule already matches and
 * the routine name deliberately shares no prefix with it. That way the
 * tiering takes effect from this change alone, with no coordinated
 * terraform edit and no window where the rule matches a name nothing
 * emits yet. Do not rename the flagged event without editing
 * `error_message` in keeperhub-security-alerts.tf in the same change.
 */

import { and, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, workflowExecutions } from "@/lib/db/schema";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { logSecurityEvent } from "@/lib/logging";

export const dynamic = "force-dynamic";

const NEW_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
// Wider than the 5-minute CronJob interval so consecutive scans overlap and
// scheduler jitter cannot drop an execution from coverage. The overlap is
// for coverage only -- it does NOT dedupe downstream (see the note on the
// alert's real 1-minute counting window above), so an execution re-emitted
// by the next scan re-pages if it is in the evidence tier. Coverage is
// worth that: narrowing this to the cron interval would silently drop an
// execution whenever a scan is late or skipped.
const EXECUTION_LOOKBACK_MS = 10 * 60 * 1000;

// Backstop for the one shape the other evidence types cannot see: many
// manual, session-driven, read-only executions, i.e. throughput abuse
// rather than compromise. Set from the live distribution of first-15-minute
// execution counts rather than picked: p50 is 1, p75 is 2, p95 is 6, and 6
// is also the highest value observed since `trigger_source` began being
// populated. It therefore fires on nothing the other predicates do not
// already catch today, which is the intent -- it exists to cover a future
// pattern, not to reclassify a current one.
const NEW_ACCOUNT_BURST_THRESHOLD = 6;

// Evidence the actor produced, as opposed to metadata they chose. Anything
// derived from workflow content is deliberately absent: `workflow_type`
// defaults to "read" and is only derived on the MCP listing path, so a
// wallet-draining workflow built in the UI editor still reads as "read".
type Evidence = "api_key" | "onchain_write" | "automated_trigger" | "burst";

type EvidenceRow = {
  triggerSource: string | null;
  triggeredByUserApiKeyId: string | null;
  triggeredByOrgApiKeyId: string | null;
  transactionHashes: unknown[] | null;
};

function collectEvidence(row: EvidenceRow, burstCount: number): Evidence[] {
  const evidence: Evidence[] = [];
  if (
    row.triggeredByUserApiKeyId !== null ||
    row.triggeredByOrgApiKeyId !== null
  ) {
    evidence.push("api_key");
  }
  if ((row.transactionHashes?.length ?? 0) > 0) {
    evidence.push("onchain_write");
  }
  // Explicitly NOT `!== "manual"`: trigger_source was introduced on
  // 2026-06-02 and is NULL for every execution before it, so a loose
  // comparison reads all of them as automated. Unknown is not evidence.
  if (row.triggerSource !== null && row.triggerSource !== "manual") {
    evidence.push("automated_trigger");
  }
  if (burstCount >= NEW_ACCOUNT_BURST_THRESHOLD) {
    evidence.push("burst");
  }
  return evidence;
}

type BehavioralScanResponse = {
  newAccountFirstWorkflowEvents: number;
  newAccountRoutineEvents: number;
  executionPredatesAccountEvents: number;
  durationMs: number;
};

async function scanNewAccountFirstWorkflow(
  startedAt: number
): Promise<BehavioralScanResponse> {
  const now = new Date();
  const accountFloor = new Date(now.getTime() - NEW_ACCOUNT_WINDOW_MS);
  const executionFloor = new Date(now.getTime() - EXECUTION_LOOKBACK_MS);

  // New-account-first-workflow: any execution within the EXECUTION_LOOKBACK_MS
  // window (10 minutes) owned by a user whose account is newer than the
  // 15-minute floor. The join captures the user's signup age so the alert
  // can carry it.
  const rows = await db
    .select({
      userId: workflowExecutions.userId,
      workflowId: workflowExecutions.workflowId,
      executionId: workflowExecutions.id,
      triggerSource: workflowExecutions.triggerSource,
      triggeredByCountry: workflowExecutions.triggeredByCountry,
      triggeredByUserApiKeyId: workflowExecutions.triggeredByUserApiKeyId,
      triggeredByOrgApiKeyId: workflowExecutions.triggeredByOrgApiKeyId,
      transactionHashes: workflowExecutions.transactionHashes,
      userCreatedAt: users.createdAt,
      executionStartedAt: workflowExecutions.startedAt,
    })
    .from(workflowExecutions)
    .innerJoin(users, eq(users.id, workflowExecutions.userId))
    .where(
      and(
        gt(workflowExecutions.startedAt, executionFloor),
        gt(users.createdAt, accountFloor),
        isNotNull(workflowExecutions.userId)
      )
    );

  // Burst is counted over the rows already in hand rather than by a second
  // query: the scan window IS the burst window, so the set is identical.
  const executionsByUser = new Map<string, number>();
  for (const row of rows) {
    if (row.userId !== null) {
      executionsByUser.set(
        row.userId,
        (executionsByUser.get(row.userId) ?? 0) + 1
      );
    }
  }

  let flaggedEvents = 0;
  let routineEvents = 0;
  let predatesAccountEvents = 0;

  for (const row of rows) {
    const ageSeconds = Math.round(
      (row.executionStartedAt.getTime() - row.userCreatedAt.getTime()) / 1000
    );

    // A negative age means the execution predates the account row, which is
    // the anonymous-to-registered conversion path re-attributing anonymous
    // work to the new user id at signup. That is the reverse of what this
    // detection is looking for, so it gets its own name instead of being
    // clamped to 0 and silently reported as "ran instantly after signup".
    if (ageSeconds < 0) {
      predatesAccountEvents += 1;
      logSecurityEvent(
        "behavioral.execution_predates_account",
        {
          userId: row.userId,
          workflowId: row.workflowId,
          executionId: row.executionId,
          triggerSource: row.triggerSource,
          triggeredByCountry: row.triggeredByCountry,
          ageSecondsSinceSignup: ageSeconds,
        },
        {
          fingerprint: [
            "security.behavioral.execution_predates_account",
            row.executionId,
          ],
          tags: { security: "behavioral.execution_predates_account" },
          user: { id: row.userId },
          extra: {
            workflowId: row.workflowId,
            executionId: row.executionId,
            ageSecondsSinceSignup: ageSeconds,
          },
        }
      );
      continue;
    }

    const evidence = collectEvidence(
      row,
      row.userId === null ? 0 : (executionsByUser.get(row.userId) ?? 0)
    );
    // An execution still running has no transaction_hashes yet, so it can be
    // classified routine on the first pass. The overlapping windows give it a
    // second read 5 minutes later, by which point anything of realistic
    // duration has finished. Rows are never skipped for this -- dropping a
    // row to wait for it to settle would lose coverage if it outlives the
    // lookback, and losing coverage is the worse failure.
    const eventName =
      evidence.length > 0
        ? "behavioral.new_account_first_workflow"
        : "behavioral.new_account_routine_execution";

    if (evidence.length > 0) {
      flaggedEvents += 1;
    } else {
      routineEvents += 1;
    }

    // Dual emit (Sentry + structured stdout) mirrors the pattern used by
    // the other detection signals in lib/security/* -- alert lands even if
    // one transport fails, and Sentry's UI gives triagers richer pivots
    // than raw Loki JSON.
    //
    // The overlapping scan windows (10-minute lookback, 5-minute interval)
    // mean the same execution is re-emitted by two consecutive scans -- and
    // ~10x in PR envs where the job runs every minute. Fingerprint on the
    // executionId so those duplicates collapse into a single Sentry issue;
    // the row's full detail still rides on each event's tags/extra.
    //
    // `evidence` rides on the event so the page says WHY it fired. Without
    // it every page reads identically and the triager has to go to the DB
    // to learn whether an API key was used or a transaction was written.
    logSecurityEvent(
      eventName,
      {
        userId: row.userId,
        workflowId: row.workflowId,
        executionId: row.executionId,
        triggerSource: row.triggerSource,
        triggeredByCountry: row.triggeredByCountry,
        ageSecondsSinceSignup: ageSeconds,
        evidence,
      },
      {
        fingerprint: [`security.${eventName}`, row.executionId],
        tags: {
          security: eventName,
          trigger_source: row.triggerSource ?? "unknown",
          evidence: evidence.length > 0 ? evidence.join(",") : "none",
        },
        user: { id: row.userId },
        extra: {
          workflowId: row.workflowId,
          executionId: row.executionId,
          triggeredByCountry: row.triggeredByCountry,
          ageSecondsSinceSignup: ageSeconds,
          evidence,
        },
      }
    );
  }

  return {
    newAccountFirstWorkflowEvents: flaggedEvents,
    newAccountRoutineEvents: routineEvents,
    executionPredatesAccountEvents: predatesAccountEvents,
    durationMs: Date.now() - startedAt,
  };
}

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();

  // Fail closed via the shared internal-service auth: the CronJob signs the
  // request with the HMAC scheme (X-KH-Caller/Timestamp/Signature, see
  // reaper.sh), which resolves to caller "scheduler". The caller check scopes
  // the endpoint to that identity -- an honest mcp/events/hub/executor caller
  // signing under its own identity is rejected, and the verdict carries the
  // attribution that lands in the auth audit log. Caveat (not overstated): in
  // v1 every producer shares one signing secret (SHARED_SECRET_KEY in
  // lib/internal-service-auth.ts), and the caller is bound into the signed
  // string, so any holder of that secret can sign AS "scheduler". This check
  // therefore gives audit attribution and blocks honest misrouting, NOT
  // cryptographic isolation from a compromised internal service -- closing
  // that needs the per-caller secret split noted in the auth module. No
  // NODE_ENV bypass: when the signature does not verify nothing matches.
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated || auth.caller !== "scheduler") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await scanNewAccountFirstWorkflow(startedAt);
    return Response.json(body);
  } catch (error) {
    // The scan itself failed (e.g. a DB error). reaper.sh now fails the
    // CronJob on a non-2xx (it checks the status), so the 500 below already
    // turns the job red -- but a generic job failure says nothing about WHY
    // detection went dark. Emit a specific, queryable self-failure signal
    // (self-guarded, dual transport) so the detection layer going dark is
    // observable as its own event rather than a bare job-failure alert, then
    // surface the 500. Mirrors content-scanner's security.content_scanner_error.
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    logSecurityEvent(
      "behavioral.scan_error",
      { message, durationMs },
      {
        level: "error",
        tags: { security: "behavioral.scan_error" },
        extra: { message, durationMs },
      }
    );
    return Response.json({ error: "scan_failed" }, { status: 500 });
  }
}

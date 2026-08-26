import { NextResponse } from "next/server";
import { ErrorCategory, logSecurityEvent, logUserError } from "@/lib/logging";
import { type OAuthScope, scopeSatisfies } from "@/lib/mcp/oauth-scopes";

/**
 * Identifies the denied caller in the security signal. Never carries the
 * credential itself -- `credentialId` is the API key row id or the
 * `oauth:<userId>` pseudo-id the execute auth helper builds.
 */
export type ScopeDenialContext = {
  organizationId?: string;
  credentialId?: string;
  endpoint?: string;
};

/**
 * A-03: enforce credential scope at the REST sinks that MCP tools forward to.
 * OAuth tokens and kh_ API keys both carry a scope (mcp:read|write|admin) the
 * MCP tool wrapper checks, but the REST routes those tools call dropped it and
 * ran any authenticated caller. `grantedScope === undefined` means the caller
 * carries no scope at all -- a cookie session, an internal service, or an API
 * key whose `scope` column is NULL -- and is intentionally full-access.
 * Returns a 403 envelope (RFC 6750 3.1) when denied, null when allowed.
 *
 * A denial is a security detection signal, not just a client error: it is a
 * credential being used outside its grant, at endpoints that move funds. Emit
 * it so the 403 rate is countable and attributable rather than silent.
 */
export function requireScope(
  grantedScope: string | undefined,
  required: OAuthScope,
  context?: ScopeDenialContext
): NextResponse | null {
  if (scopeSatisfies(grantedScope, required)) {
    return null;
  }

  // Loki only -- no Sentry argument. A scope denial is the caller using a
  // credential outside its grant, not a platform fault, and this path is
  // reachable at the caller's own request rate. lib/logging.ts states the rule
  // in logUserError's body: user errors are deliberately kept out of Sentry
  // because they are expected, high-volume, and would drown actionable system
  // errors. The structured line still lands in Loki, so a detection query over
  // repeated denials from one credential works unchanged.
  logSecurityEvent("insufficient_scope_denied", {
    required_scope: required,
    granted_scope: grantedScope ?? null,
    organizationId: context?.organizationId,
    credentialId: context?.credentialId,
    endpoint: context?.endpoint,
  });

  // logSecurityEvent writes Sentry and Loki but never Prometheus, so on its own
  // it leaves no series to alert on. This is what makes the deny rate countable
  // and gives Grafana something to threshold.
  //
  // What actually reaches Prometheus is narrower than what is passed here.
  // filterLabelsForMetric keeps only ERROR_LABELS, which carries `endpoint`
  // and the `error_context` extracted from the message prefix, but not
  // `required_scope`, `granted_scope` or `organizationId` -- those three are
  // dropped and survive only in the Loki line above. So the rate is alertable
  // per endpoint, not breakable down per scope or per organization. Adding
  // required_scope to ERROR_LABELS would enable that; organizationId should
  // stay out, since per-org labels are the cardinality the allowlist exists to
  // keep off Prometheus.
  logUserError(
    ErrorCategory.AUTH,
    "[RequireScope] Insufficient scope",
    undefined,
    {
      required_scope: required,
      granted_scope: grantedScope ?? "none",
      ...(context?.endpoint ? { endpoint: context.endpoint } : {}),
      ...(context?.organizationId
        ? { organizationId: context.organizationId }
        : {}),
    }
  );

  return NextResponse.json(
    {
      error: "insufficient_scope",
      // Written for the agent that reads it. It says what the connection may
      // do, that reconnecting cannot widen it, and who can. Naming the token
      // instead would send an agent round a loop of re-consenting with a wider
      // scope that the limit would keep clamping back.
      message: `This endpoint requires the \`${required}\` OAuth scope. This connection is allowed \`${grantedScope || "(none)"}\`. Reconnecting will not raise it: the limit is set by an organization owner or admin under Settings > Developer > Agents. Do not retry; ask them to raise it.`,
      retryable: false,
      required_scope: required,
      granted_scope: grantedScope ?? "",
    },
    { status: 403 }
  );
}

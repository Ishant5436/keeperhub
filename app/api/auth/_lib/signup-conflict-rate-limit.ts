/**
 * Rate limiter for POST /api/auth/signup-conflict.
 *
 * Deliberately does NOT share buckets with credential-attempt-rate-limit.
 * That limiter guards endpoints where a password must be supplied, so an
 * attacker cannot spend a victim's budget without one. This endpoint needs
 * only an email address, so sharing the per-email bucket would let anyone
 * lock a known address out of sign-in for the whole window at zero cost.
 *
 * Two independent limiters, both consulted on every lookup:
 *   - per-email: 5 lookups per 15 minutes per normalized email
 *   - per-IP:    15 lookups per 15 minutes per client IP
 *
 * Same process-local Map storage and lazy reset as the sibling limiters. If
 * the app grows multiple replicas, swap in a Redis-backed counter keyed the
 * same way; the public API stays the same.
 */

const WINDOW_MS = 15 * 60 * 1000;
const EMAIL_MAX = 5;
const IP_MAX = 15;

type Bucket = {
  count: number;
  resetAt: number;
};

const emailBuckets = new Map<string, Bucket>();
const ipBuckets = new Map<string, Bucket>();

export type SignupConflictRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: "email" | "ip" };

function check(
  store: Map<string, Bucket>,
  key: string,
  max: number,
  now: number
): { ok: boolean; retryAfter: number } {
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  if (existing.count >= max) {
    return {
      ok: false,
      retryAfter: Math.ceil((existing.resetAt - now) / 1000),
    };
  }
  existing.count += 1;
  return { ok: true, retryAfter: 0 };
}

export function checkSignupConflictRateLimit(
  email: string,
  ip: string
): SignupConflictRateLimitResult {
  const now = Date.now();
  const emailResult = check(emailBuckets, email, EMAIL_MAX, now);
  if (!emailResult.ok) {
    return {
      allowed: false,
      retryAfterSeconds: emailResult.retryAfter,
      scope: "email",
    };
  }
  const ipResult = check(ipBuckets, ip, IP_MAX, now);
  if (!ipResult.ok) {
    return {
      allowed: false,
      retryAfterSeconds: ipResult.retryAfter,
      scope: "ip",
    };
  }
  return { allowed: true };
}

/** Test-only hook to reset all counters between unit tests. */
export function __resetSignupConflictRateLimit(): void {
  emailBuckets.clear();
  ipBuckets.clear();
}

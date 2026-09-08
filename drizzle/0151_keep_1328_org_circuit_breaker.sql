-- Org-level incident circuit breaker (self-serve kill switch).
--
-- halted_at gates the value-ledger reservation path (per-write, fail-closed) and
-- the workflow dispatch predicate, so a tripped org stops moving value mid-run
-- and starts no new runs until an admin/owner clears it. halted_reason is a
-- free-text incident note; halted_by records the workflow id (or user id) that
-- tripped it, for audit.
--
-- Three nullable columns on the small organization table: no table rewrite, no
-- backfill, brief lock only. IF NOT EXISTS keeps re-application a no-op on any
-- DB that already has the columns.
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "halted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "halted_reason" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "halted_by" text;

-- The organization answerable for what an agentic wallet signs. Policy is
-- org-scoped, so a wallet with no organization is one no rule can reach.
ALTER TABLE "agentic_wallets" ADD COLUMN IF NOT EXISTS "organization_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agentic_wallets_organization_id_organization_id_fk'
  ) THEN
    ALTER TABLE "agentic_wallets"
      ADD CONSTRAINT "agentic_wallets_organization_id_organization_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_agentic_wallets_organization"
  ON "agentic_wallets" ("organization_id");

-- Backfill only where the answer is unambiguous: the linked user belongs to
-- exactly one organization. A user in several is a choice for a person to make,
-- not one to infer, so those rows stay null and stay ungoverned until relinked.
UPDATE "agentic_wallets" w
SET "organization_id" = m."organization_id"
FROM (
  SELECT "user_id", MIN("organization_id") AS "organization_id"
  FROM "member"
  GROUP BY "user_id"
  HAVING COUNT(DISTINCT "organization_id") = 1
) m
WHERE w."linked_user_id" = m."user_id"
  AND w."organization_id" IS NULL;

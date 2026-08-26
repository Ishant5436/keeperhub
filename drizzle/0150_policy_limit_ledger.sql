CREATE TABLE IF NOT EXISTS "policy_limit_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"sid" text NOT NULL,
	"metric" text NOT NULL,
	"window" text NOT NULL,
	"window_start" timestamp NOT NULL,
	"scope_key" text NOT NULL,
	"used" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "policy_limit_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_limit_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"usage_id" text NOT NULL,
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "policy_limit_reservations_usage_id_policy_limit_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "policy_limit_usage"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policy_limit_usage_window_idx" ON "policy_limit_usage" USING btree ("policy_id","sid","metric","window","window_start","scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_limit_usage_org_idx" ON "policy_limit_usage" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_limit_reservations_usage_idx" ON "policy_limit_reservations" USING btree ("usage_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_limit_reservations_status_idx" ON "policy_limit_reservations" USING btree ("status","expires_at");

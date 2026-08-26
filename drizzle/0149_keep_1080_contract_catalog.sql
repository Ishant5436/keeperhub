CREATE TABLE IF NOT EXISTS "contract_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"implementation_address" text,
	"protocol_slug" text,
	"abi" text,
	"abi_hash" text,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"catalog_version" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contract_catalog_chain_address_idx" ON "contract_catalog" USING btree ("chain_id","address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_catalog_protocol_idx" ON "contract_catalog" USING btree ("protocol_slug");

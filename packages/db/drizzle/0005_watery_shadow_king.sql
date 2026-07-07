CREATE TABLE "quick_creations" (
	"ip_hash" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quick_creations_ip_hash_day_pk" PRIMARY KEY("ip_hash","day")
);
--> statement-breakpoint
ALTER TABLE "docs" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "quick_key_hash" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "expires_at" timestamp with time zone;
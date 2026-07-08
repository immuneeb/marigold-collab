ALTER TABLE "comments" ADD COLUMN "author_name" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "guest" boolean DEFAULT false NOT NULL;
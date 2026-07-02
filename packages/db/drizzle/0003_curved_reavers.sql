ALTER TABLE "comments" ADD COLUMN "assigned_to_ai" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "ai_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "ai_assigned_by" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "via_assistant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ai_assigned_by_users_id_fk" FOREIGN KEY ("ai_assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_ai_assigned_idx" ON "comments" USING btree ("doc_id") WHERE "comments"."assigned_to_ai";
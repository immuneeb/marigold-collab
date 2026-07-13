CREATE TABLE "doc_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"name" text NOT NULL,
	"control_type" text NOT NULL,
	"value" jsonb NOT NULL,
	"anchored_version_id" text,
	"anchor" jsonb,
	"orphaned" boolean DEFAULT false NOT NULL,
	"reader_key" text NOT NULL,
	"reader_id" text,
	"reader_name" text,
	"guest" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_interactions" ADD CONSTRAINT "doc_interactions_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_interactions" ADD CONSTRAINT "doc_interactions_anchored_version_id_doc_versions_id_fk" FOREIGN KEY ("anchored_version_id") REFERENCES "public"."doc_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_interactions" ADD CONSTRAINT "doc_interactions_reader_id_users_id_fk" FOREIGN KEY ("reader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_interactions_doc_name_reader_uq" ON "doc_interactions" USING btree ("doc_id","name","reader_key");--> statement-breakpoint
CREATE INDEX "doc_interactions_doc_idx" ON "doc_interactions" USING btree ("doc_id");
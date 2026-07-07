CREATE TABLE "doc_events" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"actor" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_events" ADD CONSTRAINT "doc_events_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_events_doc_seq_uq" ON "doc_events" USING btree ("doc_id","seq");
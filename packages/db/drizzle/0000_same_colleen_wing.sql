CREATE TABLE "blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"byte_size" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"anchored_version_id" text,
	"parent_id" text,
	"author_id" text,
	"body" text NOT NULL,
	"anchor" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"parent_version_id" text,
	"content_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_by_assistant" text,
	"byte_size" bigint NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"render_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"latest_version_id" text,
	"published_version_id" text,
	"title" text,
	"quarantined" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_slug_unique" UNIQUE("slug"),
	CONSTRAINT "docs_render_id_unique" UNIQUE("render_id")
);
--> statement-breakpoint
CREATE TABLE "network_grants" (
	"doc_id" text NOT NULL,
	"origin" text NOT NULL,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_grants_doc_id_origin_pk" PRIMARY KEY("doc_id","origin")
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"state" text NOT NULL,
	"invited_by" text,
	"bound_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_emails" (
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "user_emails_user_id_email_pk" PRIMARY KEY("user_id","email")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_sub" text NOT NULL,
	"primary_email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_sub_unique" UNIQUE("auth_sub")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_anchored_version_id_doc_versions_id_fk" FOREIGN KEY ("anchored_version_id") REFERENCES "public"."doc_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_grants" ADD CONSTRAINT "network_grants_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_grants" ADD CONSTRAINT "network_grants_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_bound_user_id_users_id_fk" FOREIGN KEY ("bound_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_doc_status_idx" ON "comments" USING btree ("doc_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_versions_doc_ordinal_uq" ON "doc_versions" USING btree ("doc_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_versions_doc_content_uq" ON "doc_versions" USING btree ("doc_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_doc_email_uq" ON "shares" USING btree ("doc_id","email");--> statement-breakpoint
CREATE INDEX "shares_email_idx" ON "shares" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "user_emails_verified_email_uq" ON "user_emails" USING btree ("email") WHERE "user_emails"."verified";
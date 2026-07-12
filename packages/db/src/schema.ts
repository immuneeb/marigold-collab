import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ─────────────────────────────────────────────────────────────────────────────
// People
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: text("id").primaryKey(), // "usr_..."
  // Google subject id, or "dev|<email>" for the dev-only local login.
  authSub: text("auth_sub").notNull().unique(),
  primaryEmail: text("primary_email").notNull(),
  displayName: text("display_name"),
  createdAt: createdAt(),
});

// A user may control several verified emails; shares bind to verified emails.
export const userEmails = pgTable(
  "user_emails",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // normalized (lowercased, alias-folded)
    verified: boolean("verified").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.email] }),
    // One verified owner per address — prevents claiming an address you don't own.
    uniqueIndex("user_emails_verified_email_uq")
      .on(t.email)
      .where(sql`${t.verified}`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Docs: stable identity + movable pointers into the version chain
// ─────────────────────────────────────────────────────────────────────────────

export const docs = pgTable("docs", {
  id: text("id").primaryKey(), // "doc_..."
  slug: text("slug").notNull().unique(), // human-facing app path segment
  // Unguessable DNS label for the render origin: d-<renderId>.<base host>.
  renderId: text("render_id").notNull().unique(),
  // Null = unclaimed quick doc (the ?k= URL is the capability). Claiming sets
  // the owner and burns the key; owned docs behave exactly as before.
  ownerId: text("owner_id").references(() => users.id),
  // Movable refs into the version chain. Plain text (not FK) to avoid a
  // circular constraint with doc_versions; integrity enforced in app logic.
  latestVersionId: text("latest_version_id"), // assistant's most recent write
  publishedVersionId: text("published_version_id"), // what shared viewers see
  title: text("title"),
  // Link visibility: public docs are viewable (published version only) by
  // anyone, no login. Editing/commenting still requires an explicit grant.
  isPublic: boolean("is_public").notNull().default(false),
  // Kill switch (CEO-review hardening): instantly quarantine a malicious doc.
  quarantined: boolean("quarantined").notNull().default(false),
  // Quick docs (the zero-barrier HTTP door): sha256 hex of the 22-char base62
  // edit key carried in the doc URL (?k=). Never the key itself. Null on
  // owned/claimed docs — presenting a burned key grants nothing.
  quickKeyHash: text("quick_key_hash"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  // Unclaimed quick docs expire (rolling ~30 days after last write); enforced
  // on read+write, extended on each successful write, cleared on claim.
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Theme packs: when set, the doc was authored as semantic body content wrapped
  // in a built-in theme's stylesheet at ingest (packages/core themes.ts), so
  // updates can stay content-only. Null = raw full-HTML authoring. themeVersion
  // pins the theme's CSS version used at create. Additive/nullable, no backfill.
  theme: text("theme"),
  themeVersion: integer("theme_version"),
  createdAt: createdAt(),
});

// Immutable version records forming an append-only chain (git-like).
// Eng-review deviation from spec §4: `id` is a surrogate ULID, NOT the manifest
// hash (which collides across docs and on revert). Content identity lives in
// `contentHash`, unique per doc for no-op detection.
export const docVersions = pgTable(
  "doc_versions",
  {
    id: text("id").primaryKey(), // "ver_..." surrogate ULID
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(), // human-facing "v3", monotonic per doc
    parentVersionId: text("parent_version_id"), // previous version (self-ref, app-enforced)
    contentHash: text("content_hash").notNull(), // sha256 of the canonical manifest
    manifest: jsonb("manifest").notNull(), // { "index.html": "sha256:..", ... }
    createdByAssistant: text("created_by_assistant"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    title: text("title"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("doc_versions_doc_ordinal_uq").on(t.docId, t.ordinal),
    // No-op detection: identical content for the same doc is recognised here.
    uniqueIndex("doc_versions_doc_content_uq").on(t.docId, t.contentHash),
  ],
);

// Content-addressed blobs (dedup across all docs/users). `content` (base64) is
// populated only by the Postgres blob driver (BLOB_DRIVER=pg, e.g. all-Vercel);
// fs/r2 drivers leave it null and keep bytes in the object store.
export const blobs = pgTable("blobs", {
  sha256: text("sha256").primaryKey(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  storageKey: text("storage_key").notNull(), // key in object storage (or "pg/<sha>")
  content: text("content"), // base64 bytes when BLOB_DRIVER=pg
  createdAt: createdAt(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Access grants keyed by EMAIL, not user id
// ─────────────────────────────────────────────────────────────────────────────

export const shares = pgTable(
  "shares",
  {
    id: text("id").primaryKey(), // "shr_..."
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // normalized; may not yet map to a user
    role: text("role").notNull(), // 'viewer' | 'commenter' | 'editor'
    state: text("state").notNull(), // 'pending' | 'active'
    invitedBy: text("invited_by").references(() => users.id),
    boundUserId: text("bound_user_id").references(() => users.id), // set on first OAuth bind
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("shares_doc_email_uq").on(t.docId, t.email),
    index("shares_email_idx").on(t.email),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Comments + threads (modeled now for P4; not yet written to in P1-3)
// ─────────────────────────────────────────────────────────────────────────────

export const comments = pgTable(
  "comments",
  {
    id: text("id").primaryKey(), // "cmt_..."
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    anchoredVersionId: text("anchored_version_id").references(
      () => docVersions.id,
    ),
    parentId: text("parent_id"), // null = thread root (self-ref, app-enforced)
    authorId: text("author_id").references(() => users.id),
    // Guest (quick-doc) authors have no account row: a URL holder comments as a
    // guest with a self-supplied display name (stored here) and `guest` badges
    // them. Both are null/false for account authors (whose name comes from the
    // joined `users` row). Additive/nullable — no backfill.
    authorName: text("author_name"),
    guest: boolean("guest").notNull().default(false),
    body: text("body").notNull(),
    anchor: jsonb("anchor").notNull(), // composite selector (spec §8.1)
    status: text("status").notNull().default("open"), // 'open' | 'resolved' | 'orphaned'
    // "Assign to AI": editors flag a thread for the owner's AI agent to address
    // via MCP. Orthogonal to status — a comment can be open AND assigned.
    assignedToAi: boolean("assigned_to_ai").notNull().default(false),
    aiAssignedAt: timestamp("ai_assigned_at", { withTimezone: true }),
    aiAssignedBy: text("ai_assigned_by").references(() => users.id),
    // Authored through the MCP surface (an AI acting for a user) — lets the UI
    // badge agent replies without a separate "AI" principal in `users`.
    viaAssistant: boolean("via_assistant").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("comments_doc_status_idx").on(t.docId, t.status),
    index("comments_ai_assigned_idx")
      .on(t.docId)
      .where(sql`${t.assignedToAi}`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 2.1 Authorization Server (Phase 2) — public PKCE clients for MCP.
// ─────────────────────────────────────────────────────────────────────────────

export const oauthClients = pgTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientName: text("client_name"),
  redirectUris: jsonb("redirect_uris").notNull(), // string[]
  createdAt: createdAt(),
});

export const oauthCodes = pgTable("oauth_codes", {
  code: text("code").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
  resource: text("resource"),
  scope: text("scope").notNull().default(""),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const oauthRefreshTokens = pgTable("oauth_refresh_tokens", {
  tokenHash: text("token_hash").primaryKey(), // sha256 of the opaque refresh token
  clientId: text("client_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scope: text("scope").notNull().default(""),
  resource: text("resource"),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: createdAt(),
});

// Quick-doc creation rate limiting: one counter row per (hashed IP, UTC day).
// Stores only a salted sha256 of the IP, never the address itself.
export const quickCreations = pgTable(
  "quick_creations",
  {
    ipHash: text("ip_hash").notNull(),
    day: text("day").notNull(), // UTC date "YYYY-MM-DD"
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.ipHash, t.day] })],
);

// Per-doc outbound network allowlist (P7; modeled early).
export const networkGrants = pgTable(
  "network_grants",
  {
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(), // e.g. "https://api.example.com"
    approvedBy: text("approved_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.docId, t.origin] })],
);

// ─────────────────────────────────────────────────────────────────────────────
// Feedback-loop events feed
// ─────────────────────────────────────────────────────────────────────────────

// Append-only, per-doc activity log that watching agents long-poll so a human
// comment (or any change) reaches them in ≤1s instead of only on the next
// prompt. `seq` is a per-doc monotonic cursor (max(seq)+1 under the doc row
// lock, mirroring versioning.ts). Additive and never backfilled — a doc with no
// events simply has none. Core (events.ts) is the only writer.
export const docEvents = pgTable(
  "doc_events",
  {
    id: text("id").primaryKey(), // "evt_..."
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(), // per-doc monotonic, gap-free cursor
    // 'comment.created' | 'comment.resolved' | 'content.replaced' | 'version.saved'
    type: text("type").notNull(),
    // Who caused it: user id, or null for anonymous quick-key writes.
    actor: text("actor"),
    // Event-specific detail: { commentId, assignedToAi } | { versionId, ordinal }.
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => [
    // Enforces gap-free per-doc ordering AND serves the
    // `docId = ? and seq > ?  order by seq` range scan the long-poll runs.
    uniqueIndex("doc_events_doc_seq_uq").on(t.docId, t.seq),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Doc-scoped agent keys (MUN-74) — identity-anchored delegation over plain HTTP.
// A key is minted by an owner/grantee, capped at a role, labeled for
// attribution, and individually revocable. Only the sha256 is stored; the
// bearer secret is shown once at mint. Attenuation is computed at auth time:
// effective role = min(minter's CURRENT role, roleCap) — so revoking the
// minter's grant kills their keys with it.
export const agentKeys = pgTable(
  "agent_keys",
  {
    id: text("id").primaryKey(), // "akey_..."
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    minterUserId: text("minter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleCap: text("role_cap").notNull(), // 'viewer' | 'commenter' | 'editor'
    label: text("label").notNull(), // agent name shown in attribution, e.g. "bench-bot"
    keyHash: text("key_hash").notNull(), // sha256 of the bearer secret
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_keys_doc_idx").on(t.docId),
    uniqueIndex("agent_keys_key_hash_uq").on(t.keyHash),
  ],
);

// Magic-link sign-in tokens (MUN-77): single-use, short-TTL, stored hashed —
// same custody rule as every other bearer secret in the schema.
export const loginTokens = pgTable(
  "login_tokens",
  {
    tokenHash: text("token_hash").primaryKey(), // sha256 of the emailed token
    email: text("email").notNull(), // normalized target address
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("login_tokens_email_idx").on(t.email)],
);

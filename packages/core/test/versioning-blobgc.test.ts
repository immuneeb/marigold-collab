import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// F0 regression: the content-addressed blob GC (deleteDocDeep) must never
// destroy bytes a surviving or in-flight version references. These run the REAL
// createDoc/deleteDocDeep + pgBlobStore SQL (advisory locks, jsonb refcounting,
// the reference-guarded deleteBlob) against an in-memory PGlite Postgres, using
// the same @marigold/db mock as purge.test.ts. Single-connection PGlite can't
// interleave two live transactions, so the true writer-vs-GC concurrency race is
// covered by reasoning (see versioning.ts) — here we pin the deterministic
// mechanisms that make it safe: the atomic reference guard and the happy-path
// dedup/refcount that the advisory locks must not break.
const holder = vi.hoisted(
  () => ({ db: undefined }) as { db: undefined | Record<string, unknown> },
);

vi.mock("@marigold/db", async () => {
  const schema = await import("@marigold/db/schema");
  let seq = 0;
  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        const real = holder.db;
        if (!real) throw new Error("PGlite db not initialized yet");
        const v = real[prop as string];
        return typeof v === "function" ? (v as CallableFunction).bind(real) : v;
      },
    },
  );
  return {
    ...schema,
    schema,
    db,
    newId: (prefix: string) => `${prefix}_${String(++seq).padStart(10, "0")}`,
    newRenderId: () => `r${String(++seq).padStart(12, "0")}`,
  };
});

import { blobs, db, docs } from "@marigold/db";
import { getBlobStore } from "../src/blobs";
import { createDoc, deleteDocDeep } from "../src/versioning";

const DDL = `
create table docs (
  id text primary key,
  slug text not null unique,
  render_id text not null unique,
  owner_id text,
  latest_version_id text,
  published_version_id text,
  title text,
  is_public boolean not null default false,
  quarantined boolean not null default false,
  quick_key_hash text,
  claimed_at timestamptz,
  expires_at timestamptz,
  theme text,
  theme_version integer,
  created_at timestamptz not null default now()
);
create table doc_versions (
  id text primary key,
  doc_id text not null references docs(id) on delete cascade,
  ordinal integer not null,
  parent_version_id text,
  content_hash text not null,
  manifest jsonb not null,
  created_by_assistant text,
  byte_size bigint not null,
  title text,
  created_at timestamptz not null default now(),
  unique (doc_id, ordinal),
  unique (doc_id, content_hash)
);
create table blobs (
  sha256 text primary key,
  byte_size bigint not null,
  storage_key text not null,
  content text,
  created_at timestamptz not null default now()
);
`;

let pg: PGlite;

beforeAll(async () => {
  process.env.BLOB_DRIVER = "pg"; // bytes live in blobs.content — no repo .blobs dir
  pg = new PGlite();
  holder.db = drizzle(pg) as unknown as Record<string, unknown>;
  await pg.exec(DDL);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("truncate table docs, doc_versions, blobs cascade");
});

const page = (n: string) =>
  `<!doctype html><html><body><h1 id="t">${n}</h1></body></html>`;

const allShas = async () =>
  (await db.select({ s: blobs.sha256 }).from(blobs)).map((r) => r.s).sort();

describe("pgBlobStore.deleteBlob is reference-guarded (F0)", () => {
  it("keeps a sha a surviving version still references; removes an orphan", async () => {
    const store = getBlobStore();
    await createDoc({ ownerId: "u1", html: page("kept") });
    const [{ s: refSha }] = await db.select({ s: blobs.sha256 }).from(blobs);
    // An unreferenced blob nobody points at.
    await store.putBlob("sha-orphan", new TextEncoder().encode("x"));

    await store.deleteBlob(refSha); // referenced → the NOT EXISTS guard keeps it
    await store.deleteBlob("sha-orphan"); // no reference → removed

    expect(await allShas()).toEqual([refSha]);
    // Bytes for the referenced blob are intact (a would-be post-commit stomp is
    // exactly what the guard prevents).
    expect(await store.getBlob(refSha)).not.toBeNull();
  });

  it("is idempotent on an already-absent sha", async () => {
    const store = getBlobStore();
    await store.deleteBlob("never-existed");
    expect(await allShas()).toEqual([]);
  });
});

describe("createDoc + deleteDocDeep end-to-end with advisory locks (F0)", () => {
  it("dedups identical content and only GCs the blob once nothing references it", async () => {
    const store = getBlobStore();
    // Two docs, identical content → one deduped, content-addressed blob.
    const a = await createDoc({ ownerId: "u1", html: page("shared") });
    const b = await createDoc({ ownerId: "u2", html: page("shared") });
    const shas = await allShas();
    expect(shas.length).toBe(1);
    const [sha] = shas;
    expect(await store.getBlob(sha)).not.toBeNull();

    // Delete doc A: B still references the shared blob → survives.
    const d1 = await deleteDocDeep(a.docId);
    expect(d1).not.toBeNull();
    expect(d1!.orphanShas).toEqual([]);
    expect(await store.getBlob(sha)).not.toBeNull();
    expect(
      (await db.select({ id: docs.id }).from(docs)).map((r) => r.id),
    ).toEqual([b.docId]);

    // Delete doc B: now truly orphaned → the blob and its bytes go.
    const d2 = await deleteDocDeep(b.docId);
    expect(d2!.orphanShas).toEqual([sha]);
    expect(await allShas()).toEqual([]);
    expect(await store.getBlob(sha)).toBeNull();
  });

  it("a fresh create's bytes are retrievable (locks + recordBlobRows intact)", async () => {
    const store = getBlobStore();
    const r = await createDoc({ ownerId: "u1", html: page("solo") });
    const [{ s: sha }] = await db.select({ s: blobs.sha256 }).from(blobs);
    const bytes = await store.getBlob(sha);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toContain("solo");
    expect(r.ordinal).toBe(1);
  });
});

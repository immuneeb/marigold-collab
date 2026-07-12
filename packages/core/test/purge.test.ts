import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Purge tests run the REAL SQL (row-lock guard, jsonb_each_text blob
// refcounting, cascades) against an in-memory PGlite Postgres: the mock swaps
// @marigold/db's postgres.js singleton for a drizzle-over-PGlite instance while
// re-exporting the actual schema tables. The `db` export is a Proxy that
// delegates to the instance created in beforeAll (the mock factory is hoisted
// and runs before PGlite exists).
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

import {
  blobs,
  db,
  docs,
  docVersions,
  loginTokens,
  quickCreations,
} from "@marigold/db";
import {
  DEFAULT_PURGE_GRACE_DAYS,
  purgeExpiredQuickDocs,
  purgeStaleLoginTokens,
  purgeStaleQuickCreations,
} from "../src/purge";
import { deleteDocDeep } from "../src/versioning";

// Minimal DDL mirroring packages/db/src/schema.ts for the tables the purge
// touches. The doc_versions → docs ON DELETE CASCADE is load-bearing
// (deleteDocDeep relies on it); owner_id is plain text (no users FK needed).
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
create table quick_creations (
  ip_hash text not null,
  day text not null,
  count integer not null default 0,
  primary key (ip_hash, day)
);
create table login_tokens (
  token_hash text primary key,
  email text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
`;

let pg: PGlite;

beforeAll(async () => {
  // pg blob driver: post-commit storage cleanup hits the (mocked) db instead
  // of writing an .blobs dir into the repo. Must be set before the first
  // getBlobStore() call (it caches the driver).
  process.env.BLOB_DRIVER = "pg";
  pg = new PGlite();
  holder.db = drizzle(pg) as unknown as Record<string, unknown>;
  await pg.exec(DDL);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    "truncate table docs, doc_versions, blobs, quick_creations, login_tokens cascade",
  );
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number, from = new Date()) =>
  new Date(from.getTime() - n * DAY_MS);

/** Seed a doc with one version per shas[i] entry (each entry = that version's
 * manifest values) plus the blob rows, mirroring what createDoc/updateDoc
 * write. Blobs are upserted so docs can share shas (content-address dedup). */
async function seedDoc(opts: {
  id: string;
  ownerId?: string | null;
  expiresAt?: Date | null;
  versions: string[][];
}) {
  const { id } = opts;
  await db.insert(docs).values({
    id,
    slug: `slug-${id}`,
    renderId: `render-${id}`,
    ownerId: opts.ownerId ?? null,
    quickKeyHash: opts.ownerId ? null : `kh-${id}`,
    expiresAt: opts.expiresAt ?? null,
    latestVersionId: `${id}-v${opts.versions.length}`,
    publishedVersionId: `${id}-v${opts.versions.length}`,
  });
  for (const [i, shas] of opts.versions.entries()) {
    await db.insert(docVersions).values({
      id: `${id}-v${i + 1}`,
      docId: id,
      ordinal: i + 1,
      contentHash: `ch-${id}-${i + 1}`,
      manifest: Object.fromEntries(
        shas.map((s, j) => [j === 0 ? "index.html" : `asset-${j}`, s]),
      ),
      byteSize: 100,
    });
    for (const s of shas) {
      await db
        .insert(blobs)
        .values({ sha256: s, byteSize: 5, storageKey: `pg/${s}`, content: "aGk=" })
        .onConflictDoNothing();
    }
  }
}

const allDocIds = async () =>
  (await db.select({ id: docs.id }).from(docs)).map((r) => r.id).sort();
const allBlobShas = async () =>
  (await db.select({ s: blobs.sha256 }).from(blobs)).map((r) => r.s).sort();

describe("purgeExpiredQuickDocs — blob refcount edge", () => {
  it("purging one of two docs sharing a blob keeps the shared blob", async () => {
    await seedDoc({
      id: "docA",
      expiresAt: daysAgo(20),
      versions: [["sha-shared", "sha-only-a"]],
    });
    // Same content hash lives in docB too (content-addressed dedup) — expired,
    // but inside the 14-day grace window, so it survives this run.
    await seedDoc({ id: "docB", expiresAt: daysAgo(1), versions: [["sha-shared"]] });

    const res = await purgeExpiredQuickDocs({ graceDays: 14 });

    expect(res).toMatchObject({ candidates: 1, docs: 1, versions: 1, blobs: 1 });
    expect(await allDocIds()).toEqual(["docB"]);
    // Shared blob survives (docB-v1 still references it); docA-only blob is gone.
    expect(await allBlobShas()).toEqual(["sha-shared"]);
    // Cascade removed docA's version rows.
    const versions = await db.select({ id: docVersions.id }).from(docVersions);
    expect(versions.map((v) => v.id)).toEqual(["docB-v1"]);
  });

  it("purging both sharers removes the blob", async () => {
    await seedDoc({ id: "docA", expiresAt: daysAgo(20), versions: [["sha-shared"]] });
    await seedDoc({ id: "docB", expiresAt: daysAgo(30), versions: [["sha-shared"]] });

    const res = await purgeExpiredQuickDocs({ graceDays: 14 });

    expect(res).toMatchObject({ candidates: 2, docs: 2, versions: 2, blobs: 1 });
    expect(await allDocIds()).toEqual([]);
    expect(await allBlobShas()).toEqual([]);
  });

  it("a blob shared with a CLAIMED doc survives purging the unclaimed sharer", async () => {
    await seedDoc({ id: "docA", expiresAt: daysAgo(20), versions: [["sha-shared"]] });
    await seedDoc({ id: "docC", ownerId: "usr_1", versions: [["sha-shared"]] });

    const res = await purgeExpiredQuickDocs({ graceDays: 14 });

    expect(res).toMatchObject({ docs: 1, blobs: 0 });
    expect(await allDocIds()).toEqual(["docC"]);
    expect(await allBlobShas()).toEqual(["sha-shared"]);
  });
});

describe("purgeExpiredQuickDocs — selection criteria", () => {
  it("never touches claimed docs, even with a stale past expiry", async () => {
    await seedDoc({
      id: "claimed",
      ownerId: "usr_1",
      expiresAt: daysAgo(100),
      versions: [["sha-c"]],
    });

    const res = await purgeExpiredQuickDocs({ graceDays: 14 });

    expect(res).toMatchObject({ candidates: 0, docs: 0 });
    expect(await allDocIds()).toEqual(["claimed"]);
  });

  it("respects the grace window (expired < grace stays, > grace goes)", async () => {
    await seedDoc({ id: "recent", expiresAt: daysAgo(13), versions: [["sha-r"]] });
    await seedDoc({ id: "old", expiresAt: daysAgo(15), versions: [["sha-o"]] });
    await seedDoc({ id: "live", expiresAt: daysAgo(-10), versions: [["sha-l"]] });
    await seedDoc({ id: "noexpiry", expiresAt: null, versions: [["sha-n"]] });

    const res = await purgeExpiredQuickDocs({ graceDays: 14 });

    expect(res).toMatchObject({ candidates: 1, docs: 1 });
    expect(await allDocIds()).toEqual(["live", "noexpiry", "recent"]);
  });

  it("counts all versions of a purged doc and is idempotent", async () => {
    await seedDoc({
      id: "multi",
      expiresAt: daysAgo(20),
      versions: [["sha-1"], ["sha-1", "sha-2"]],
    });

    const first = await purgeExpiredQuickDocs({ graceDays: 14 });
    expect(first).toMatchObject({ docs: 1, versions: 2, blobs: 2 });

    const second = await purgeExpiredQuickDocs({ graceDays: 14 });
    expect(second).toMatchObject({ candidates: 0, docs: 0, versions: 0, blobs: 0 });
  });

  it("batches: at most `batch` docs per run, oldest expiry first", async () => {
    await seedDoc({ id: "d1", expiresAt: daysAgo(40), versions: [["sha-d1"]] });
    await seedDoc({ id: "d2", expiresAt: daysAgo(30), versions: [["sha-d2"]] });
    await seedDoc({ id: "d3", expiresAt: daysAgo(20), versions: [["sha-d3"]] });

    const first = await purgeExpiredQuickDocs({ graceDays: 14, batch: 2 });
    expect(first).toMatchObject({ candidates: 2, docs: 2 });
    expect(await allDocIds()).toEqual(["d3"]); // oldest two went first

    const second = await purgeExpiredQuickDocs({ graceDays: 14, batch: 2 });
    expect(second).toMatchObject({ candidates: 1, docs: 1 });
    expect(await allDocIds()).toEqual([]);
  });

  it("defaults to a 14-day grace window", () => {
    expect(DEFAULT_PURGE_GRACE_DAYS).toBe(14);
  });
});

describe("deleteDocDeep guard (claim wins the race)", () => {
  it("skips a doc claimed between candidate selection and deletion", async () => {
    await seedDoc({ id: "raced", expiresAt: daysAgo(20), versions: [["sha-x"]] });
    const cutoff = daysAgo(14);

    // Simulate: purge selected "raced" as a candidate, then a claim landed.
    await db
      .update(docs)
      .set({ ownerId: "usr_9", expiresAt: null, quickKeyHash: null })
      .where(eq(docs.id, "raced"));

    const detail = await deleteDocDeep(
      "raced",
      (d) =>
        d.ownerId === null &&
        d.expiresAt !== null &&
        d.expiresAt.getTime() < cutoff.getTime(),
    );

    expect(detail).toBeNull();
    expect(await allDocIds()).toEqual(["raced"]);
    expect(await allBlobShas()).toEqual(["sha-x"]);
  });

  it("returns nulls for missing docs (idempotent deletes)", async () => {
    expect(await deleteDocDeep("nope")).toBeNull();
  });
});

describe("purgeStaleQuickCreations", () => {
  it("removes only buckets older than the 7-day retention", async () => {
    const dayOf = (n: number) => daysAgo(n).toISOString().slice(0, 10);
    await db.insert(quickCreations).values([
      { ipHash: "h1", day: dayOf(0), count: 3 },
      { ipHash: "h1", day: dayOf(6), count: 1 },
      { ipHash: "h2", day: dayOf(8), count: 5 },
      { ipHash: "h3", day: dayOf(30), count: 2 },
    ]);

    const res = await purgeStaleQuickCreations();
    expect(res.rows).toBe(2);

    const left = await db
      .select({ day: quickCreations.day })
      .from(quickCreations);
    expect(left.map((r) => r.day).sort()).toEqual([dayOf(6), dayOf(0)].sort());

    // Idempotent.
    expect((await purgeStaleQuickCreations()).rows).toBe(0);
  });
});

describe("purgeStaleLoginTokens", () => {
  it("removes tokens expired past retention, keeps recent ones (F10)", async () => {
    const at = (n: number) => daysAgo(n); // token expiry n days ago (or ahead)
    await db.insert(loginTokens).values([
      { tokenHash: "t-live", email: "a@x.com", expiresAt: daysAgo(-1) }, // valid
      { tokenHash: "t-recent", email: "a@x.com", expiresAt: at(3) }, // expired 3d ago
      { tokenHash: "t-old", email: "b@x.com", expiresAt: at(10) }, // expired 10d ago
      {
        tokenHash: "t-old-consumed",
        email: "c@x.com",
        expiresAt: at(30),
        consumedAt: at(30),
      }, // consumed + long expired
    ]);

    const res = await purgeStaleLoginTokens(); // 7-day retention

    expect(res.rows).toBe(2); // t-old + t-old-consumed
    const left = (
      await db.select({ h: loginTokens.tokenHash }).from(loginTokens)
    ).map((r) => r.h);
    expect(left.sort()).toEqual(["t-live", "t-recent"]);

    // Idempotent.
    expect((await purgeStaleLoginTokens()).rows).toBe(0);
  });
});

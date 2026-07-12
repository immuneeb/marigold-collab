import { beforeEach, describe, expect, it, vi } from "vitest";

// The DB-touching functions issue queries shaped select().from().where()
// .limit(1) / .orderBy(), plus update().set().where() and insert().values().
// Feed selects from a FIFO of result rows; record writes for assertions
// (same pattern as acl-resolve.test.ts).
const { queue, updates, inserts } = vi.hoisted(() => ({
  queue: [] as unknown[][],
  updates: [] as unknown[],
  inserts: [] as unknown[],
}));

vi.mock("@marigold/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
          orderBy: async () => queue.shift() ?? [],
        }),
      }),
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    }),
    insert: () => ({
      values: async (v: unknown) => {
        inserts.push(v);
      },
    }),
  };
  return { ...actual, db };
});

import {
  attenuate,
  mintAgentKey,
  resolveAgentKey,
  revokeAgentKey,
  sanitizeAgentKeyLabel,
} from "../src/agent-keys";
import { generateQuickKey, hashQuickKey } from "../src/quick";

beforeEach(() => {
  queue.length = 0;
  updates.length = 0;
  inserts.length = 0;
});

describe("attenuate (effective role = min(minter's current role, roleCap))", () => {
  it("editor minter + editor cap = editor", () => {
    expect(attenuate("editor", "editor")).toBe("editor");
  });

  it("commenter minter + editor cap = commenter (cap can't lift the minter)", () => {
    expect(attenuate("commenter", "editor")).toBe("commenter");
  });

  it("revoked minter grant (null role) = null — keys die with the grant", () => {
    expect(attenuate(null, "editor")).toBe(null);
    expect(attenuate(null, "viewer")).toBe(null);
  });

  it("owner minter is clamped to the cap — delegation never confers owner", () => {
    expect(attenuate("owner", "editor")).toBe("editor");
    expect(attenuate("owner", "viewer")).toBe("viewer");
  });

  it("cap below the minter's role wins", () => {
    expect(attenuate("editor", "viewer")).toBe("viewer");
    expect(attenuate("editor", "commenter")).toBe("commenter");
  });

  it("viewer minter + editor cap = viewer", () => {
    expect(attenuate("viewer", "editor")).toBe("viewer");
  });
});

describe("sanitizeAgentKeyLabel", () => {
  it("trims and collapses whitespace", () => {
    expect(sanitizeAgentKeyLabel("  my   agent \n")).toBe("my agent");
  });

  it("rejects empty, too-long, and non-string labels", () => {
    expect(sanitizeAgentKeyLabel("")).toBe(null);
    expect(sanitizeAgentKeyLabel("   ")).toBe(null);
    expect(sanitizeAgentKeyLabel("x".repeat(41))).toBe(null);
    expect(sanitizeAgentKeyLabel(42)).toBe(null);
    expect(sanitizeAgentKeyLabel(undefined)).toBe(null);
  });

  it("keeps a 40-char label", () => {
    const l = "a".repeat(40);
    expect(sanitizeAgentKeyLabel(l)).toBe(l);
  });
});

describe("mintAgentKey", () => {
  it("stores only the sha256 of the bearer secret, never the key", async () => {
    const minted = await mintAgentKey({
      id: "akey_1",
      docId: "doc_1",
      minterUserId: "usr_m",
      roleCap: "editor",
      label: "bench-bot",
    });
    expect(minted.key).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as Record<string, unknown>;
    expect(row.keyHash).toBe(hashQuickKey(minted.key));
    expect(Object.values(row)).not.toContain(minted.key);
  });
});

describe("resolveAgentKey", () => {
  it("resolves a live key whose hash matches", async () => {
    const key = generateQuickKey();
    queue.push([
      {
        id: "akey_1",
        docId: "doc_1",
        minterUserId: "usr_m",
        roleCap: "editor",
        label: "bot",
        keyHash: hashQuickKey(key),
        revokedAt: null,
      },
    ]);
    const row = await resolveAgentKey("doc_1", key);
    expect(row?.id).toBe("akey_1");
  });

  it("returns null when no row matches (wrong doc, revoked, or unknown key)", async () => {
    queue.push([]); // the SQL predicate excluded everything
    expect(await resolveAgentKey("doc_B", generateQuickKey())).toBe(null);
  });

  it("re-verifies the hash timing-safely — a mismatched row never resolves", async () => {
    queue.push([
      {
        id: "akey_1",
        docId: "doc_1",
        minterUserId: "usr_m",
        roleCap: "editor",
        label: "bot",
        keyHash: hashQuickKey(generateQuickKey()), // different secret
        revokedAt: null,
      },
    ]);
    expect(await resolveAgentKey("doc_1", generateQuickKey())).toBe(null);
  });

  it("returns null without querying for an absent key", async () => {
    expect(await resolveAgentKey("doc_1", null)).toBe(null);
    expect(await resolveAgentKey("doc_1", undefined)).toBe(null);
    expect(queue).toHaveLength(0);
  });
});

describe("revokeAgentKey", () => {
  const keyRow = (over: Record<string, unknown> = {}) => ({
    id: "akey_1",
    docId: "doc_1",
    minterUserId: "usr_minter",
    roleCap: "editor",
    label: "bot",
    keyHash: "h",
    revokedAt: null,
    ...over,
  });

  it("owner revokes any key on the doc", async () => {
    queue.push([keyRow()]);
    queue.push([{ ownerId: "usr_owner" }]);
    expect(await revokeAgentKey("doc_1", "akey_1", "usr_owner")).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it("minter revokes their own key", async () => {
    queue.push([keyRow()]);
    queue.push([{ ownerId: "usr_owner" }]);
    expect(await revokeAgentKey("doc_1", "akey_1", "usr_minter")).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it("anyone else may not revoke", async () => {
    queue.push([keyRow()]);
    queue.push([{ ownerId: "usr_owner" }]);
    expect(await revokeAgentKey("doc_1", "akey_1", "usr_stranger")).toBe(
      false,
    );
    expect(updates).toHaveLength(0);
  });

  it("missing key (or key on another doc) returns false", async () => {
    queue.push([]);
    expect(await revokeAgentKey("doc_1", "akey_missing", "usr_owner")).toBe(
      false,
    );
  });

  it("already-revoked is idempotent true without a second write", async () => {
    queue.push([keyRow({ revokedAt: new Date() })]);
    queue.push([{ ownerId: "usr_owner" }]);
    expect(await revokeAgentKey("doc_1", "akey_1", "usr_owner")).toBe(true);
    expect(updates).toHaveLength(0);
  });
});

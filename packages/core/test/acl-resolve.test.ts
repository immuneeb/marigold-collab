import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveRole issues (up to) two queries, both shaped
// select().from().where().limit(1) — feed them from a FIFO of result rows.
const { queue } = vi.hoisted(() => ({ queue: [] as unknown[][] }));

vi.mock("@marigold/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    }),
  };
  return { ...actual, db };
});

import { authorize, resolveRole } from "../src/acl";

const anon = { userId: null, verifiedEmails: [] };

beforeEach(() => {
  queue.length = 0;
});

describe("resolveRole with public docs", () => {
  it("missing doc resolves to null", async () => {
    queue.push([]);
    expect(await resolveRole("doc_x", null, [])).toBe(null);
  });

  it("anonymous gets viewer on a public doc", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: true }]);
    expect(await resolveRole("doc_1", null, [])).toBe("viewer");
  });

  it("anonymous gets null on a private doc", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: false }]);
    expect(await resolveRole("doc_1", null, [])).toBe(null);
  });

  it("owner resolves to owner regardless of visibility", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: true }]);
    expect(await resolveRole("doc_1", "usr_owner", ["o@x.com"])).toBe("owner");
  });

  it("an explicit share outranks the public viewer fallback", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: true }]);
    queue.push([{ role: "editor" }]);
    expect(await resolveRole("doc_1", "usr_e", ["e@x.com"])).toBe("editor");
  });

  it("signed-in user without a share gets viewer on a public doc", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: true }]);
    queue.push([]); // no grant
    expect(await resolveRole("doc_1", "usr_s", ["s@x.com"])).toBe("viewer");
  });

  it("signed-in user without a share gets null on a private doc", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: false }]);
    queue.push([]); // no grant
    expect(await resolveRole("doc_1", "usr_s", ["s@x.com"])).toBe(null);
  });
});

describe("resolveRole with quarantined docs", () => {
  it("owner still resolves (needs manage to lift the quarantine)", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: true, quarantined: true }]);
    expect(await resolveRole("doc_1", "usr_owner", ["o@x.com"])).toBe("owner");
  });

  it("an active share loses access while quarantined", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: false, quarantined: true }]);
    expect(await resolveRole("doc_1", "usr_e", ["e@x.com"])).toBe(null);
  });

  it("anonymous loses access to a quarantined public doc", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: true, quarantined: true }]);
    expect(await resolveRole("doc_1", null, [])).toBe(null);
  });
});

describe("authorize on public docs", () => {
  it("anonymous may view", async () => {
    queue.push([{ ownerId: "usr_owner", isPublic: true }]);
    expect(await authorize("doc_1", anon, "view")).toEqual({
      ok: true,
      role: "viewer",
    });
  });

  it.each(["comment", "update", "publish", "manage", "delete"] as const)(
    "anonymous may NOT %s",
    async (action) => {
      queue.push([{ ownerId: "usr_owner", isPublic: true }]);
      const res = await authorize("doc_1", anon, action);
      expect(res.ok).toBe(false);
      expect(res.role).toBe("viewer");
    },
  );
});

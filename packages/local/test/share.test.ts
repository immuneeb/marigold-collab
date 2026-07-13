import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveShareTitle, ShareError, shareDraft } from "../src/share";

function tmpHtml(contents: string, name = "draft.html"): string {
  const dir = mkdtempSync(join(tmpdir(), "mgl-share-"));
  const file = join(dir, name);
  writeFileSync(file, contents);
  return file;
}

interface QuickCall {
  url: string;
  body: { title: string; html: string };
}

/** A fetch double that records the quick-door call and replies with `status`. */
function recordingFetch(
  status: number,
  responseBody: unknown,
): { fetchImpl: typeof fetch; calls: QuickCall[] } {
  const calls: QuickCall[] = [];
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as QuickCall["body"] });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const SUCCESS = {
  docId: "d1",
  slug: "sunny-fox-42",
  url: "https://marigold.page/d/sunny-fox-42?k=key123",
  editKey: "key123",
  claimUrl: "https://marigold.page/claim/d1?k=key123",
  expiresAt: "2026-08-11T00:00:00.000Z",
};

describe("shareDraft", () => {
  it("posts {title, html} to /api/quick and returns the quick doc on 201", async () => {
    const file = tmpHtml(
      "<!doctype html><html><head><title>My Report</title></head><body><h1>Hi</h1></body></html>",
    );
    const { fetchImpl, calls } = recordingFetch(201, SUCCESS);

    const res = await shareDraft(file, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://marigold.page/api/quick");
    // No override → title is lifted from the file's <title> tag.
    expect(calls[0]!.body.title).toBe("My Report");
    expect(calls[0]!.body.html).toContain("<h1>Hi</h1>");
    expect(res.slug).toBe("sunny-fox-42");
    expect(res.url).toContain("?k=key123");
    expect(res.claimUrl).toContain("/claim/d1");
  });

  it("honours --origin and --title overrides", async () => {
    const file = tmpHtml("<!doctype html><title>Ignored</title><p>x</p>");
    const { fetchImpl, calls } = recordingFetch(201, SUCCESS);

    await shareDraft(file, { fetchImpl, origin: "http://localhost:3000/", title: "Override" });

    expect(calls[0]!.url).toBe("http://localhost:3000/api/quick"); // trailing slash trimmed
    expect(calls[0]!.body.title).toBe("Override");
  });

  it("throws a ShareError carrying the server error + hint on 429", async () => {
    const file = tmpHtml("<h1>frag</h1>");
    const { fetchImpl } = recordingFetch(429, {
      error: "rate_limited",
      hint: "Unclaimed quick docs are capped at 20 per IP per day. Try again tomorrow, or sign in.",
    });

    const err = await shareDraft(file, { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShareError);
    expect((err as ShareError).message).toBe("rate_limited");
    expect((err as ShareError).status).toBe(429);
    expect((err as ShareError).hint).toContain("capped at 20");
  });

  it("rejects non-.html files and missing files clearly", async () => {
    await expect(shareDraft("/tmp/notreal.txt")).rejects.toThrow(/only \.html/);
    await expect(shareDraft("/tmp/does-not-exist-xyz.html")).rejects.toThrow(/file not found/);
  });
});

describe("resolveShareTitle", () => {
  it("prefers the override, then <title>, then the filename", () => {
    expect(resolveShareTitle("<title>T</title>", "/a/b/page.html", "Over")).toBe("Over");
    expect(resolveShareTitle("<title>  Spaced  </title>", "/a/b/page.html")).toBe("Spaced");
    expect(resolveShareTitle("<p>no title</p>", "/a/b/my-page.html")).toBe("my-page");
  });
});

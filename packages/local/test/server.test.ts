import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalServer, type ReviewPayload } from "../src/server";

// Isolate the persisted doc registry from the real ~/.marigold-local.
process.env.MARIGOLD_LOCAL_HOME = mkdtempSync(join(tmpdir(), "mgl-home-"));

let server: LocalServer;
let base: string;
let dir: string;
let file: string;
let docId: string;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init);
}
async function post(path: string, body: unknown): Promise<Response> {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mgl-srv-"));
  file = join(dir, "draft.html");
  writeFileSync(file, "<h1>Draft</h1><p>The quick brown fox jumps over the lazy dog.</p>");
  server = new LocalServer({ watchDebounceMs: 30 });
  const port = await server.listen(0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => server.close());

describe("local review loop", () => {
  it("registers a doc idempotently", async () => {
    const r1 = await post("/api/open", { path: file, title: "My Draft" });
    expect(r1.ok).toBe(true);
    const d1 = (await r1.json()) as { docId: string; url: string };
    const r2 = await post("/api/open", { path: file });
    const d2 = (await r2.json()) as { docId: string };
    expect(d2.docId).toBe(d1.docId);
    docId = d1.docId;
  });

  it("serves the instrumented frame with the agent + prod-parity CSP", async () => {
    const r = await api(`/d/${docId}/frame`);
    const html = await r.text();
    expect(html).toContain("data-marigold-id");
    expect(html).toContain("/__mg/agent.js");
    expect(r.headers.get("content-security-policy")).toContain("connect-src 'none'");
  });

  it("serves the shell and the anchor agent", async () => {
    const shell = await (await api(`/d/${docId}`)).text();
    expect(shell).toContain("Send feedback to agent");
    const agent = await (await api("/__mg/agent.js")).text();
    expect(agent).toContain("postMessage");
  });

  it("accepts comments, replies and status changes", async () => {
    const frame = await (await api(`/d/${docId}/frame`)).text();
    const mgid = /data-marigold-id="(mg-[0-9a-f]{10})"/.exec(frame)![1]!;
    const c = (await (
      await post(`/api/docs/${docId}/comments`, {
        body: "Make this pop",
        anchor: { marigoldId: mgid, textQuote: { exact: "quick brown fox" } },
      })
    ).json()) as { id: string };
    expect(c.id).toBe("c1");

    const rep = await post(`/api/docs/${docId}/comments/${c.id}/replies`, {
      body: "done",
      viaAssistant: true,
    });
    expect(rep.ok).toBe(true);

    const doc = (await (await api(`/api/docs/${docId}`)).json()) as {
      comments: { id: string; parentId: string | null; viaAssistant: boolean }[];
    };
    expect(doc.comments).toHaveLength(2);
    expect(doc.comments[1]!.parentId).toBe(c.id);
    expect(doc.comments[1]!.viaAssistant).toBe(true);
  });

  it("submit resolves a parked wait with the review payload", async () => {
    const waitP = api(`/api/docs/${docId}/wait?timeout=10`);
    await new Promise((r) => setTimeout(r, 100));
    const sub = await post(`/api/docs/${docId}/submit`, { overallComment: "ship it" });
    expect(sub.ok).toBe(true);
    const w = await waitP;
    expect(w.status).toBe(200);
    const payload = (await w.json()) as ReviewPayload;
    expect(payload.event).toBe("review.completed");
    expect(payload.overallComment).toBe("ship it");
    expect(payload.openComments).toHaveLength(1);
    expect(payload.openComments[0]!.anchoredText).toContain("quick brown fox");
    expect(payload.openComments[0]!.replies).toHaveLength(1);
  });

  it("wait?since= hands over a missed round immediately", async () => {
    const r = await api(`/api/docs/${docId}/wait?timeout=5&since=0`);
    expect(r.status).toBe(200);
    const payload = (await r.json()) as ReviewPayload;
    expect(payload.reviewSeq).toBe(1);
  });

  it("file edits bump the version and re-anchor comments", async () => {
    const before = (await (await api(`/api/docs/${docId}`)).json()) as { version: number };
    writeFileSync(file, "<h1>Draft v2</h1><p>The quick brown fox jumps over the lazy dog.</p>");
    let after = before;
    for (let i = 0; i < 50 && after.version === before.version; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = (await (await api(`/api/docs/${docId}`)).json()) as { version: number };
    }
    expect(after.version).toBeGreaterThan(before.version);
    const doc = (await (await api(`/api/docs/${docId}`)).json()) as {
      comments: { status: string }[];
    };
    expect(doc.comments[0]!.status).toBe("open"); // re-anchored, not orphaned
  });

  it("inline-edit writes through to the file", async () => {
    const frame = await (await api(`/d/${docId}/frame`)).text();
    const h1 = /<h1 data-marigold-id="(mg-[0-9a-f]{10})"/.exec(frame)![1]!;
    const r = await post(`/api/docs/${docId}/inline-edit`, {
      edits: [{ marigoldId: h1, html: "Draft v3 (edited in place)" }],
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Draft v3 (edited in place)");
  });

  it("a restarted daemon lazily re-opens known docs (old tabs keep working)", async () => {
    const server2 = new LocalServer({ watchDebounceMs: 30 });
    const port2 = await server2.listen(0);
    try {
      // No POST /api/open on server2 — resolution must come from the registry.
      const r = await fetch(`http://127.0.0.1:${port2}/api/docs/${docId}`);
      expect(r.status).toBe(200);
      const d = (await r.json()) as { comments: unknown[] };
      expect(d.comments.length).toBeGreaterThan(0); // sidecar reloaded too
      const frame = await fetch(`http://127.0.0.1:${port2}/d/${docId}/frame`);
      expect(frame.status).toBe(200);
    } finally {
      server2.close();
    }
  });

  it("wraps fragments and unwraps them on inline-edit write-back", async () => {
    const frag = join(dir, "frag.html");
    writeFileSync(frag, "<h2>Section</h2><p>Fragment body</p>");
    const d = (await (await post("/api/open", { path: frag })).json()) as { docId: string };
    const frame = await (await api(`/d/${d.docId}/frame`)).text();
    expect(frame).toContain("mg-wrap");
    const h2 = /<h2 data-marigold-id="(mg-[0-9a-f]{10})"/.exec(frame)![1]!;
    const r = await post(`/api/docs/${d.docId}/inline-edit`, {
      edits: [{ marigoldId: h2, html: "Section (edited)" }],
    });
    expect(r.ok).toBe(true);
    const src = readFileSync(frag, "utf8");
    expect(src).toContain("Section (edited)");
    expect(src).not.toContain("<html"); // still a fragment
    expect(src).not.toContain("data-marigold-id"); // written back clean
  });
});

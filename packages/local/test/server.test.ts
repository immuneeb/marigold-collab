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
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'none'");
    // Explicit host-source: 'self' is useless to a sandboxed (opaque-origin)
    // document in WebKit — the agent script must be allowed by origin.
    expect(csp).toMatch(/script-src [^;]*http:\/\/127\.0\.0\.1:\d+/);
    expect(csp).toMatch(/script-src [^;]*http:\/\/localhost:\d+/);
  });

  it("serves the shell and the anchor agent", async () => {
    const shell = await (await api(`/d/${docId}`)).text();
    expect(shell).toContain("Send feedback to agent");
    // New-comment is bound to plain C, not the macOS-colliding ⌘⌥M chord.
    expect(shell).toContain('title="Add a comment — C"');
    expect(shell).not.toContain("KeyM");
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
    expect(((await sub.json()) as { agentListening: boolean }).agentListening).toBe(true);
    const w = await waitP;
    expect(w.status).toBe(200);
    const payload = (await w.json()) as ReviewPayload;
    expect(payload.event).toBe("review.completed");
    expect(payload.overallComment).toBe("ship it");
    // The freeform text is ALSO a doc-level comment — durable and addressable.
    expect(payload.openComments).toHaveLength(2);
    const anchored = payload.openComments.find((c) => c.anchoredText)!;
    expect(anchored.anchoredText).toContain("quick brown fox");
    expect(anchored.replies).toHaveLength(1);
    const overall = payload.openComments.find((c) => c.kind === "overall")!;
    expect(overall.body).toBe("ship it");
    expect(overall.anchoredText).toBeNull();
    // Delivered live — a fresh wait must block, not re-deliver.
    const again = await api(`/api/docs/${docId}/wait?timeout=1`);
    expect(again.status).toBe(204);
  });

  it("delivers a round submitted while no agent was listening", async () => {
    const sub = await post(`/api/docs/${docId}/submit`, { overallComment: "anyone there?" });
    expect(((await sub.json()) as { agentListening: boolean }).agentListening).toBe(false);
    // The next wait gets the missed round immediately — late, never lost.
    const r = await api(`/api/docs/${docId}/wait?timeout=10`);
    expect(r.status).toBe(200);
    const payload = (await r.json()) as ReviewPayload;
    expect(payload.overallComment).toBe("anyone there?");
    // …and exactly once.
    const again = await api(`/api/docs/${docId}/wait?timeout=1`);
    expect(again.status).toBe(204);
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
      comments: { status: string; kind?: string }[];
    };
    expect(doc.comments[0]!.status).toBe("open"); // re-anchored, not orphaned
    // Anchor-less doc-level comments are exempt from re-anchoring — never orphaned.
    const overalls = doc.comments.filter((c) => c.kind === "overall");
    expect(overalls.length).toBeGreaterThan(0);
    for (const o of overalls) expect(o.status).toBe("open");
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

  it("agent listen stream: presence, live delivery, connect catch-up", async () => {
    async function readReview(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      timeoutMs: number,
    ): Promise<Record<string, unknown> | null> {
      const dec = new TextDecoder();
      let buf = "";
      let event = "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const chunk = (await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
        ])) as { done: boolean; value?: Uint8Array } | null;
        if (!chunk || chunk.done) return null;
        buf += dec.decode(chunk.value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trimEnd();
          buf = buf.slice(i + 1);
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) {
            if (event === "review") return JSON.parse(line.slice(6)) as Record<string, unknown>;
            event = "";
          }
        }
      }
      return null;
    }

    // No waiter, no listener → not present.
    let doc = (await (await api(`/api/docs/${docId}`)).json()) as { agentListening: boolean };
    expect(doc.agentListening).toBe(false);

    // Listener connects → presence flips, submits stream live.
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/agent/listen`, { signal: ac.signal });
    expect(stream.ok).toBe(true);
    const reader = stream.body!.getReader();
    doc = (await (await api(`/api/docs/${docId}`)).json()) as { agentListening: boolean };
    expect(doc.agentListening).toBe(true);

    const sub = await post(`/api/docs/${docId}/submit`, { overallComment: "via listener" });
    expect(((await sub.json()) as { agentListening: boolean }).agentListening).toBe(true);
    const live = await readReview(reader, 5000);
    expect(live?.overallComment).toBe("via listener");
    // Delivered via the stream — a wait must block, not re-deliver.
    expect((await api(`/api/docs/${docId}/wait?timeout=1`)).status).toBe(204);

    // Disconnect → presence drops; a round submitted now is caught up by the
    // next listener the moment it connects.
    ac.abort();
    await new Promise((r) => setTimeout(r, 150));
    doc = (await (await api(`/api/docs/${docId}`)).json()) as { agentListening: boolean };
    expect(doc.agentListening).toBe(false);
    await post(`/api/docs/${docId}/submit`, { overallComment: "while away" });

    const ac2 = new AbortController();
    const stream2 = await fetch(`${base}/api/agent/listen`, { signal: ac2.signal });
    const caught = await readReview(stream2.body!.getReader(), 5000);
    expect(caught?.overallComment).toBe("while away");
    ac2.abort();
  });

  it("scoped listen: only covered drafts wake the listener; presence is per-doc", async () => {
    async function readReviews(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      timeoutMs: number,
    ): Promise<Record<string, unknown>[]> {
      const dec = new TextDecoder();
      const out: Record<string, unknown>[] = [];
      let buf = "";
      let event = "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const chunk = (await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
        ])) as { done: boolean; value?: Uint8Array } | null;
        if (!chunk || chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trimEnd();
          buf = buf.slice(i + 1);
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) {
            if (event === "review") out.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
            event = "";
          }
        }
      }
      return out;
    }

    // Two "sessions": each with its own drafts dir.
    const dirA = mkdtempSync(join(tmpdir(), "mgl-sess-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "mgl-sess-b-"));
    const fileA = join(dirA, "a.html");
    const fileB = join(dirB, "b.html");
    writeFileSync(fileA, "<h1>Session A draft</h1>");
    writeFileSync(fileB, "<h1>Session B draft</h1>");
    const docA = ((await (await post("/api/open", { path: fileA })).json()) as { docId: string }).docId;
    const docB = ((await (await post("/api/open", { path: fileB })).json()) as { docId: string }).docId;

    // Listener scoped to session A's dir (dir prefix covers files inside it).
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/agent/listen?scope=${encodeURIComponent(dirA)}`, { signal: ac.signal });
    expect(stream.ok).toBe(true);
    const reader = stream.body!.getReader();

    // Presence is per-doc: A shows an agent, B does not.
    const dA = (await (await api(`/api/docs/${docA}`)).json()) as { agentListening: boolean };
    const dB = (await (await api(`/api/docs/${docB}`)).json()) as { agentListening: boolean };
    expect(dA.agentListening).toBe(true);
    expect(dB.agentListening).toBe(false);

    // A round on B must NOT reach the A-scoped listener…
    const subB = await post(`/api/docs/${docB}/submit`, { overallComment: "for session B" });
    expect(((await subB.json()) as { agentListening: boolean }).agentListening).toBe(false);
    // …but a round on A must.
    await post(`/api/docs/${docA}/submit`, { overallComment: "for session A" });
    const got = await readReviews(reader, 1500);
    expect(got.map((r) => r.overallComment)).toEqual(["for session A"]);
    ac.abort();
    await new Promise((r) => setTimeout(r, 150));

    // B's round was durably parked (undelivered) — a B-scoped listener catches
    // it up on connect and never sees A's already-delivered round.
    const ac2 = new AbortController();
    const stream2 = await fetch(`${base}/api/agent/listen?scope=${encodeURIComponent(fileB)}`, { signal: ac2.signal });
    const caught = await readReviews(stream2.body!.getReader(), 1500);
    expect(caught.map((r) => r.overallComment)).toEqual(["for session B"]);
    ac2.abort();
    await new Promise((r) => setTimeout(r, 150));
  }, 15000);

  it("aggregates freeform text across multiple undelivered rounds", async () => {
    // Three rounds land while no agent is listening; the catch-up wait must
    // carry EVERY round's freeform text, not just the last round's.
    // (The previous test's aborted listener disconnects asynchronously.)
    for (let i = 0; i < 50; i++) {
      const d = (await (await api(`/api/docs/${docId}`)).json()) as { agentListening: boolean };
      if (!d.agentListening) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await post(`/api/docs/${docId}/submit`, { overallComment: "first thought" });
    await post(`/api/docs/${docId}/submit`, {});
    await post(`/api/docs/${docId}/submit`, { overallComment: "second thought" });
    const r = await api(`/api/docs/${docId}/wait?timeout=10`);
    expect(r.status).toBe(200);
    const payload = (await r.json()) as ReviewPayload;
    expect(payload.overallComment).toBe("first thought\n\nsecond thought");
    // …and both texts are open doc-level comments in the same payload.
    const bodies = payload.openComments.filter((c) => c.kind === "overall").map((c) => c.body);
    expect(bodies).toContain("first thought");
    expect(bodies).toContain("second thought");
  });

  it("records a change on a file-write bump, attributed AI, consuming the noted intent", async () => {
    const f = join(dir, "hist-srv.html");
    writeFileSync(f, "<h1>One</h1><p>original paragraph text here</p>");
    const d = (await (await post("/api/open", { path: f })).json()) as { docId: string; version: number };

    // `note` sets the intent the next save records.
    const nr = await post(`/api/docs/${d.docId}/note`, { intent: "sharpen the paragraph" });
    expect(nr.ok).toBe(true);

    writeFileSync(f, "<h1>One</h1><p>a completely rewritten paragraph body</p>");
    let hist = { version: 0, changes: [] as { version: number; actor: string; intent?: string; diffStats: { added: number; removed: number; changed: number } }[] };
    for (let i = 0; i < 50 && hist.changes.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 60));
      hist = (await (await api(`/api/docs/${d.docId}/history`)).json()) as typeof hist;
    }
    expect(hist.changes.length).toBeGreaterThan(0);
    const latest = hist.changes[0]!; // most recent first
    expect(latest.actor).toBe("AI");
    expect(latest.intent).toBe("sharpen the paragraph");
    expect(latest.diffStats.added + latest.diffStats.removed + latest.diffStats.changed).toBeGreaterThan(0);

    // The intent was consumed — a second save carries none.
    writeFileSync(f, "<h1>One</h1><p>a completely rewritten paragraph body, extended</p>");
    let after = hist;
    for (let i = 0; i < 50 && after.changes.length === hist.changes.length; i++) {
      await new Promise((r) => setTimeout(r, 60));
      after = (await (await api(`/api/docs/${d.docId}/history`)).json()) as typeof hist;
    }
    expect(after.changes.length).toBeGreaterThan(hist.changes.length);
    expect(after.changes[0]!.intent).toBeUndefined();
  });

  it("cold-open records a daemon-down edit as an AI change, consuming the noted intent", async () => {
    const f = join(dir, "cold.html");
    writeFileSync(f, "<h1>Cold</h1><p>version one body text here</p>");

    // A first daemon opens the doc; the agent notes intent for its next save.
    const s1 = new LocalServer({ watchDebounceMs: 30 });
    const p1 = await s1.listen(0);
    const post1 = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${p1}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = (await (await post1("/api/open", { path: f })).json()) as { docId: string; version: number };
    await post1(`/api/docs/${d.docId}/note`, { intent: "rewrite while offline" });
    s1.close();

    // The file diverges from the persisted baseline while the daemon is down.
    writeFileSync(f, "<h1>Cold</h1><p>a fully rewritten version two body</p>");

    // A fresh daemon lazily re-opens from the registry — the divergence must be
    // recorded as an AI change carrying (and consuming) the noted intent, not
    // silently swallowed by a baseline re-seed.
    const s2 = new LocalServer({ watchDebounceMs: 30 });
    const p2 = await s2.listen(0);
    try {
      const hist = (await (await fetch(`http://127.0.0.1:${p2}/api/docs/${d.docId}/history`)).json()) as {
        changes: { version: number; actor: string; intent?: string; diffStats: { added: number; removed: number; changed: number } }[];
      };
      expect(hist.changes.length).toBeGreaterThan(0);
      const top = hist.changes[0]!; // most recent first
      expect(top.actor).toBe("AI");
      expect(top.intent).toBe("rewrite while offline");
      expect(top.version).toBeGreaterThan(d.version);
      expect(top.diffStats.changed).toBeGreaterThan(0);
    } finally {
      s2.close();
    }
  });

  it("a You inline-edit leaves the noted intent pending for the next AI save", async () => {
    const f = join(dir, "you.html");
    writeFileSync(f, "<h1>You</h1><p>original paragraph body</p>");
    const d = (await (await post("/api/open", { path: f })).json()) as { docId: string };
    const frame = await (await api(`/d/${d.docId}/frame`)).text();
    const pid = /<p data-marigold-id="(mg-[0-9a-f]{10})"/.exec(frame)![1]!;

    await post(`/api/docs/${d.docId}/note`, { intent: "for the AI save" });

    // A reviewer inline edit is attributed "You" and must NOT consume the intent.
    const ie = await post(`/api/docs/${d.docId}/inline-edit`, {
      edits: [{ marigoldId: pid, html: "reviewer-edited paragraph body" }],
    });
    expect(ie.ok).toBe(true);
    let hist = (await (await api(`/api/docs/${d.docId}/history`)).json()) as {
      changes: { actor: string; intent?: string }[];
    };
    expect(hist.changes[0]!.actor).toBe("You");
    expect(hist.changes[0]!.intent).toBeUndefined();

    // The still-pending intent is consumed by the next AI file write.
    await new Promise((r) => setTimeout(r, 850)); // clear the inline-edit self-write window
    writeFileSync(f, "<h1>You</h1><p>the agent's rewrite of the paragraph</p>");
    let after = hist;
    for (let i = 0; i < 40 && after.changes.length === hist.changes.length; i++) {
      await new Promise((r) => setTimeout(r, 60));
      after = (await (await api(`/api/docs/${d.docId}/history`)).json()) as typeof hist;
    }
    expect(after.changes.length).toBeGreaterThan(hist.changes.length);
    expect(after.changes[0]!.actor).toBe("AI");
    expect(after.changes[0]!.intent).toBe("for the AI save");
  });

  it("resolve stamps resolvedAtVersion and context pairs it to a later change", async () => {
    const f = join(dir, "ctx-srv.html");
    writeFileSync(f, "<h1>Doc</h1><p>needs a fix in this line</p>");
    const d = (await (await post("/api/open", { path: f })).json()) as { docId: string };
    const frame = await (await api(`/d/${d.docId}/frame`)).text();
    const pid = /<p data-marigold-id="(mg-[0-9a-f]{10})"/.exec(frame)![1]!;
    const c = (await (
      await post(`/api/docs/${d.docId}/comments`, {
        body: "fix this line",
        anchor: { marigoldId: pid, textQuote: { exact: "needs a fix" } },
      })
    ).json()) as { id: string };

    // Resolve — stamps the current version.
    const pr = await api(`/api/docs/${d.docId}/comments/${c.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(pr.ok).toBe(true);

    // A subsequent edit is the correction.
    writeFileSync(f, "<h1>Doc</h1><p>this line is now fixed and clear</p>");
    let ctx = { openComments: [] as unknown[], recentChanges: [] as unknown[], corrections: [] as { comment: { id: string }; change: { version: number } | null }[] };
    for (let i = 0; i < 50 && ctx.corrections.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 60));
      ctx = (await (await api(`/api/docs/${d.docId}/context`)).json()) as typeof ctx;
    }
    expect(ctx.corrections).toHaveLength(1);
    expect(ctx.corrections[0]!.comment.id).toBe(c.id);
    expect(ctx.corrections[0]!.change).not.toBeNull();
    // The resolved comment is not in the open set.
    expect(ctx.openComments).toHaveLength(0);
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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instrumentHtml } from "@marigold/core/instrument";
import { diffInstrumented } from "@marigold/core/diff";
import {
  applyAgentReopen,
  applyAgentResolve,
  applyReviewerReopen,
  applyReviewerResolve,
  applyStatusChange,
  buildContext,
  buildEpisodes,
  buildHistory,
  decodeBaseline,
  docIdFor,
  encodeBaseline,
  isFullDocument,
  loadSidecar,
  prepareHtml,
  pushChange,
  reanchorComments,
  saveSidecar,
  trimSummary,
  wrapFragment,
  MAX_CHANGES,
  MAX_REJECTED_FIXES,
  type LocalChange,
  type LocalComment,
} from "../src/store";

function comment(anchor: LocalComment["anchor"], status: LocalComment["status"] = "open"): LocalComment {
  return {
    id: "c1",
    parentId: null,
    author: "You",
    body: "test",
    anchor,
    status,
    viaAssistant: false,
    createdAt: new Date().toISOString(),
  };
}

describe("fragment handling", () => {
  it("detects full documents", () => {
    expect(isFullDocument("<!doctype html><html><body>x</body></html>")).toBe(true);
    expect(isFullDocument("<html lang='en'>x</html>")).toBe(true);
    expect(isFullDocument("<h1>Hello</h1><p>fragment</p>")).toBe(false);
    expect(isFullDocument('<svg viewBox="0 0 10 10"><rect/></svg>')).toBe(false);
  });

  it("wraps fragments deterministically (stable ids across identical input)", () => {
    const frag = "<h1>Title</h1><p>Body text here</p>";
    const a = instrumentHtml(prepareHtml(frag, "T"));
    const b = instrumentHtml(prepareHtml(frag, "T"));
    expect(a).toBe(b);
    expect(a).toContain("data-marigold-id");
    expect(a).toContain("mg-wrap");
  });

  it("wraps svg sources so they render inline and get ids", () => {
    const svg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"></circle></svg>';
    const out = instrumentHtml(wrapFragment(svg, "diagram"));
    expect(out).toContain("<svg");
    expect(out.match(/data-marigold-id/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("reanchorComments", () => {
  const v1 = instrumentHtml("<h1>Alpha</h1><p>The quick brown fox jumps over the dog</p>");
  const idOf = (html: string, tag: string) =>
    new RegExp(`<${tag} data-marigold-id="(mg-[0-9a-f]{10})"`).exec(html)?.[1] ??
    new RegExp(`<${tag}[^>]*data-marigold-id="(mg-[0-9a-f]{10})"`).exec(html)![1]!;

  it("keeps a stable id across an unrelated edit", () => {
    const pid = idOf(v1, "p");
    const c = comment({ marigoldId: pid, textQuote: { exact: "quick brown fox" } });
    const v2 = instrumentHtml("<h1>Alpha CHANGED</h1><p>The quick brown fox jumps over the dog</p>");
    reanchorComments([c], v2);
    expect(c.status).toBe("open");
    expect(c.anchor!.marigoldId).toBe(pid);
  });

  it("orphans when the anchored element disappears", () => {
    const pid = idOf(v1, "p");
    const c = comment({ marigoldId: pid, textQuote: { exact: "totally gone sentence" } });
    const v2 = instrumentHtml("<h1>Alpha</h1>");
    reanchorComments([c], v2);
    expect(c.status).toBe("orphaned");
  });

  it("recovers an orphan via text quote and refreshes the id", () => {
    const c = comment(
      { marigoldId: "mg-dead000000", textQuote: { exact: "quick brown fox jumps" } },
      "orphaned",
    );
    const changed = reanchorComments([c], v1);
    expect(changed).toBe(true);
    expect(c.status).toBe("open");
    expect(c.anchor!.marigoldId).toMatch(/^mg-[0-9a-f]{10}$/);
  });
});

describe("sidecar", () => {
  it("round-trips and derives a stable docId from the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "draft.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    expect(sc.docId).toBe(docIdFor(file));
    expect(sc.changes).toEqual([]); // fresh sidecars carry an empty history
    sc.comments.push(comment(null));
    saveSidecar(file, sc);
    const again = loadSidecar(file);
    expect(again.comments).toHaveLength(1);
    expect(again.docId).toBe(sc.docId);
  });

  it("loads a pre-change-history sidecar with an empty changes list", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "old.html");
    writeFileSync(file, "<p>x</p>");
    // A sidecar written before this feature has no `changes` field.
    writeFileSync(
      `${file}.marigold.json`,
      JSON.stringify({ docId: "mgl-old", title: "Old", seq: 0, version: 3, comments: [], reviews: [] }),
    );
    const sc = loadSidecar(file);
    expect(sc.changes).toEqual([]);
    expect(sc.version).toBe(3);
  });

  it("round-trips changes[] and the gzip baseline through save/load", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "hist.html");
    const source = "<h1>Alpha</h1><p>The quick brown fox jumps over the lazy dog.</p>";
    writeFileSync(file, source);
    const sc = loadSidecar(file);
    const change: LocalChange = {
      version: 2,
      at: new Date().toISOString(),
      actor: "AI",
      intent: "tighten the intro",
      summary: diffInstrumented(source, "<h1>Alpha</h1><p>The lazy dog sleeps.</p>"),
    };
    pushChange(sc, change);
    sc.baseline = encodeBaseline(source, 1);
    saveSidecar(file, sc);

    const again = loadSidecar(file);
    expect(again.changes).toHaveLength(1);
    expect(again.changes[0]!.intent).toBe("tighten the intro");
    expect(again.changes[0]!.actor).toBe("AI");
    expect(again.changes[0]!.summary.stats.changed).toBeGreaterThan(0);
    expect(decodeBaseline(again.baseline)).toBe(source); // gzip survived the round-trip
  });

  it("pushChange caps the history at MAX_CHANGES (most recent kept)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "cap.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    const empty = diffInstrumented("<p>a</p>", "<p>b</p>");
    for (let v = 1; v <= MAX_CHANGES + 5; v++) {
      pushChange(sc, { version: v, at: new Date().toISOString(), actor: "AI", summary: empty });
    }
    expect(sc.changes).toHaveLength(MAX_CHANGES);
    expect(sc.changes[0]!.version).toBe(6); // oldest 5 dropped
    expect(sc.changes.at(-1)!.version).toBe(MAX_CHANGES + 5);
  });
});

describe("trimSummary", () => {
  it("caps each list to the sample size, keeps true stats, and flags truncation", () => {
    const before = Array.from({ length: 10 }, (_, i) => `<p>original paragraph number ${i}</p>`).join("");
    const after = Array.from({ length: 10 }, (_, i) => `<p>rewritten paragraph number ${i}</p>`).join("");
    const full = diffInstrumented(before, after);
    expect(full.stats.changed).toBe(10); // every paragraph changed

    const trimmed = trimSummary(full);
    expect(trimmed.changed.length).toBe(6); // capped to CHANGE_SAMPLE
    expect(trimmed.stats.changed).toBe(10); // true count preserved
    expect(trimmed.truncated).toBe(true);
  });

  it("leaves a small summary untouched and unflagged", () => {
    const full = diffInstrumented("<p>one two three</p>", "<p>one two four</p>");
    const trimmed = trimSummary(full);
    expect(trimmed.changed.length).toBe(1);
    expect(trimmed.truncated).toBeUndefined();
  });
});

describe("history + context digest", () => {
  const change = (version: number, actor: "You" | "AI", intent?: string): LocalChange => ({
    version,
    at: new Date().toISOString(),
    actor,
    ...(intent ? { intent } : {}),
    summary: diffInstrumented("<h1>A</h1><p>old text</p>", "<h1>A</h1><p>new text</p>"),
  });

  it("buildHistory returns most-recent-first, capped at the limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "h.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    pushChange(sc, change(1, "AI"));
    pushChange(sc, change(2, "You"));
    pushChange(sc, change(3, "AI", "why v3"));
    const hist = buildHistory(sc, 2);
    expect(hist.map((h) => h.version)).toEqual([3, 2]);
    expect(hist[0]!.intent).toBe("why v3");
    expect(hist[0]!.diffStats.changed).toBeGreaterThan(0);
  });

  it("buildContext yields one episode per thread with the full chain and terminal state", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "cx.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);

    const confirmed = comment({ textQuote: { exact: "confirmed one" } }, "resolved");
    confirmed.id = "c1";
    confirmed.resolution = "confirmed";
    confirmed.resolvedAtVersion = 2;
    const proposed = comment({ textQuote: { exact: "proposed one" } }, "resolved");
    proposed.id = "c2";
    proposed.resolution = "proposed";
    proposed.resolvedAtVersion = 3;
    const legacy = comment({ textQuote: { exact: "legacy one" } }, "resolved");
    legacy.id = "c3";
    legacy.resolvedAtVersion = 1;
    const openC = comment({ textQuote: { exact: "still open" } }, "open");
    openC.id = "c4";
    sc.comments.push(confirmed, proposed, legacy, openC);
    pushChange(sc, change(2, "AI", "the fix"));

    const ctx = buildContext(sc);
    // One episode per thread; open comments remain listed separately.
    expect(ctx.episodes.map((e) => e.threadId).sort()).toEqual(["c1", "c2", "c3", "c4"]);
    expect(ctx.openComments.map((c) => c.id)).toEqual(["c4"]);
    const byId = Object.fromEntries(ctx.episodes.map((e) => [e.threadId, e]));
    expect(byId.c1!.terminalState).toBe("confirmed");
    expect(byId.c2!.terminalState).toBe("proposed");
    expect(byId.c3!.terminalState).toBe("confirmed"); // legacy resolved → confirmed
    expect(byId.c4!.terminalState).toBe("open");
    // The standing resolve stamp is an attempt joined to the change at/after it.
    expect(byId.c1!.attempts).toHaveLength(1);
    expect(byId.c1!.attempts[0]!.kind).toBe("resolved");
    expect(byId.c1!.attempts[0]!.change!.version).toBe(2);
    expect(byId.c1!.attempts[0]!.change!.intent).toBe("the fix");
  });

  it("an episode tells the full propose→reopen→re-resolve→confirm chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "chain.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    // Simulate the lifecycle via the transition helpers + interleaved changes.
    const c = comment({ textQuote: { exact: "the line" } }, "open");
    c.id = "c1";
    sc.comments.push(c);
    pushChange(sc, change(2, "AI", "first attempt"));
    applyAgentResolve(c, 2); // propose at v2
    applyReviewerReopen(c, "missed the point"); // reviewer rejects → rejectedFix v2
    pushChange(sc, change(3, "AI", "second attempt"));
    applyAgentResolve(c, 3); // propose again at v3
    applyReviewerResolve(c, 3); // reviewer confirms

    const ep = buildEpisodes(sc)[0]!;
    expect(ep.terminalState).toBe("confirmed");
    expect(ep.reopenCount).toBe(1);
    // Attempts: the rejected v2 fix (chronologically first) then the standing v3.
    expect(ep.attempts.map((a) => [a.kind, a.version])).toEqual([
      ["rejected", 2],
      ["resolved", 3],
    ]);
    expect(ep.attempts[0]!.note).toBe("missed the point");
    expect(ep.attempts[0]!.change!.intent).toBe("first attempt");
    expect(ep.attempts[1]!.change!.intent).toBe("second attempt");
  });

  it("buildContext exposes no synthesized insights (the daemon layers those in)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgl-"));
    const file = join(dir, "ins.html");
    writeFileSync(file, "<p>x</p>");
    const sc = loadSidecar(file);
    expect(buildContext(sc).insights).toEqual([]);
  });
});

describe("status transitions (MUN-127)", () => {
  it("an agent resolve is only a proposal, stamped at the current version", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyAgentResolve(c, 5);
    expect(c.status).toBe("resolved");
    expect(c.resolution).toBe("proposed");
    expect(c.resolvedAtVersion).toBe(5);
  });

  it("a reviewer confirm upgrades a proposal to confirmed and keeps its version", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyAgentResolve(c, 5); // agent proposes at v5
    applyReviewerResolve(c, 9); // reviewer confirms later, at v9
    expect(c.status).toBe("resolved");
    expect(c.resolution).toBe("confirmed");
    expect(c.resolvedAtVersion).toBe(5); // confirming keeps the proposal's version
  });

  it("a fresh reviewer resolve (no prior proposal) is confirmed and stamps now", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyReviewerResolve(c, 7);
    expect(c.resolution).toBe("confirmed");
    expect(c.resolvedAtVersion).toBe(7);
  });

  it("a reviewer reopen records the rejected fix and clears the stamp", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyAgentResolve(c, 5);
    applyReviewerReopen(c, "not what I meant");
    expect(c.status).toBe("open");
    expect(c.resolution).toBeUndefined();
    expect(c.resolvedAtVersion).toBeUndefined();
    expect(c.rejectedFixes).toHaveLength(1);
    expect(c.rejectedFixes![0]!.version).toBe(5);
    expect(c.rejectedFixes![0]!.note).toBe("not what I meant");
  });

  it("an agent reopen clears state without recording a rejection", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyAgentResolve(c, 5);
    applyAgentReopen(c);
    expect(c.status).toBe("open");
    expect(c.resolution).toBeUndefined();
    expect(c.resolvedAtVersion).toBeUndefined();
    expect(c.rejectedFixes).toBeUndefined(); // agent reopen is not a negative signal
  });

  it("rejected fixes are capped at MAX_REJECTED_FIXES, most recent kept", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    for (let v = 1; v <= MAX_REJECTED_FIXES + 3; v++) {
      applyStatusChange(c, "resolved", "agent", v);
      applyStatusChange(c, "open", "reviewer", v);
    }
    expect(c.rejectedFixes).toHaveLength(MAX_REJECTED_FIXES);
    // oldest dropped, newest retained
    expect(c.rejectedFixes![0]!.version).toBe(4);
    expect(c.rejectedFixes!.at(-1)!.version).toBe(MAX_REJECTED_FIXES + 3);
  });

  it("applyStatusChange dispatches by actor: agent resolve proposes, reviewer resolve confirms", () => {
    const a = comment({ textQuote: { exact: "a" } }, "open");
    applyStatusChange(a, "resolved", "agent", 3);
    expect(a.resolution).toBe("proposed");
    const b = comment({ textQuote: { exact: "b" } }, "open");
    applyStatusChange(b, "resolved", "reviewer", 3);
    expect(b.resolution).toBe("confirmed");
  });

  it("an agent re-resolve does NOT downgrade a reviewer-confirmed thread or re-stamp its version", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyAgentResolve(c, 3); // agent proposes at v3
    applyReviewerResolve(c, 3); // reviewer confirms at v3
    // Agent retries a resolve later, at v7 — must be a no-op.
    const changed = applyAgentResolve(c, 7);
    expect(changed).toBe(false);
    expect(c.resolution).toBe("confirmed"); // NOT downgraded to proposed
    expect(c.resolvedAtVersion).toBe(3); // NOT re-pointed to v7
  });

  it("an agent re-resolve of its own proposal is a no-op (keeps version, stays proposed)", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyAgentResolve(c, 3);
    const changed = applyAgentResolve(c, 7);
    expect(changed).toBe(false);
    expect(c.resolution).toBe("proposed");
    expect(c.resolvedAtVersion).toBe(3);
  });

  it("a reviewer resolve is idempotent on an already-confirmed thread", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyReviewerResolve(c, 3);
    const changed = applyReviewerResolve(c, 9);
    expect(changed).toBe(false);
    expect(c.resolvedAtVersion).toBe(3);
  });

  it("a double reviewer reopen records exactly one rejected fix", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    applyAgentResolve(c, 5);
    const first = applyReviewerReopen(c);
    const second = applyReviewerReopen(c); // already open — no-op
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(c.rejectedFixes).toHaveLength(1);
    expect(c.rejectedFixes![0]!.version).toBe(5);
  });

  it("an agent reopen is a no-op when the comment is already open", () => {
    const c = comment({ textQuote: { exact: "x" } }, "open");
    expect(applyAgentReopen(c)).toBe(false);
  });
});

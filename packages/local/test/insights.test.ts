import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applySaveInsight,
  loadInsights,
  markDirtyForThread,
  saveInsights,
  similarActiveInsights,
  statementSimilarity,
  type Insight,
} from "../src/insights";

// Isolate the machine-level insights file from the real ~/.marigold-local.
process.env.MARIGOLD_LOCAL_HOME = mkdtempSync(join(tmpdir(), "mgl-ins-"));

const ev = (docId: string, commentId: string) => ({ docId, commentId, relation: "supports" as const });
// Evidence with no preset relation — lets the save mode set it (refines/contradicts).
const raw = (docId: string, commentId: string) => ({ docId, commentId });

describe("insights file IO", () => {
  beforeEach(() => saveInsights([]));

  it("an absent file reads as empty; writes round-trip", () => {
    // Fresh temp home under a subdir that doesn't exist yet.
    process.env.MARIGOLD_LOCAL_HOME = mkdtempSync(join(tmpdir(), "mgl-ins2-"));
    expect(loadInsights()).toEqual([]);
    const list: Insight[] = [];
    const r = applySaveInsight(list, { statement: "green means shipped", evidence: [ev("d1", "c1")] });
    expect(r.ok).toBe(true);
    saveInsights(list);
    const again = loadInsights();
    expect(again).toHaveLength(1);
    expect(again[0]!.statement).toBe("green means shipped");
    expect(again[0]!.evidence[0]!.relation).toBe("supports");
  });
});

describe("statement similarity", () => {
  it("scores a terse statement and a verbose restatement as close", () => {
    const s = statementSimilarity("green means shipped", "a green badge means the draft has shipped");
    expect(s).toBeGreaterThanOrEqual(0.5);
  });
  it("scores unrelated statements as low", () => {
    expect(statementSimilarity("green means shipped", "use serif fonts for headings")).toBeLessThan(0.5);
  });
});

describe("applySaveInsight", () => {
  it("rejects a create with no evidence", () => {
    const r = applySaveInsight([], { statement: "x", evidence: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/evidence/);
  });

  it("forces a choice against a similar active insight, and distinctFrom clears it", () => {
    const list: Insight[] = [];
    applySaveInsight(list, { statement: "green means the draft shipped", evidence: [ev("d1", "c1")] });
    // A near-duplicate is refused with the candidate surfaced.
    const dup = applySaveInsight(list, { statement: "a green badge means shipped", evidence: [ev("d1", "c2")] });
    expect(dup.ok).toBe(false);
    expect(dup.candidates).toHaveLength(1);
    expect(list).toHaveLength(1); // not created

    // Re-asserting distinctFrom the surfaced candidate allows the create.
    const ok = applySaveInsight(list, {
      statement: "a green badge means shipped",
      evidence: [ev("d1", "c2")],
      distinctFrom: [dup.candidates![0]!.id],
    });
    expect(ok.ok).toBe(true);
    expect(list).toHaveLength(2);
  });

  it("reinforce appends evidence and clears the dirty flag", () => {
    const list: Insight[] = [];
    const created = applySaveInsight(list, { statement: "s", evidence: [ev("d1", "c1")] }).insight!;
    created.evidenceDirty = true;
    const r = applySaveInsight(list, { targetId: created.id, relation: "reinforce", evidence: [ev("d2", "c9")] });
    expect(r.ok).toBe(true);
    expect(created.evidence).toHaveLength(2);
    expect(created.evidenceDirty).toBe(false);
  });

  it("refine creates a new row that supersedes and retires the old one", () => {
    const list: Insight[] = [];
    const old = applySaveInsight(list, { statement: "green means shipped", evidence: [ev("d1", "c1")] }).insight!;
    const r = applySaveInsight(list, {
      targetId: old.id,
      relation: "refine",
      statement: "green means shipped AND claimed",
      evidence: [raw("d1", "c5")],
    });
    expect(r.ok).toBe(true);
    expect(r.retiredId).toBe(old.id);
    expect(old.status).toBe("retired");
    expect(old.supersededById).toBe(r.insight!.id);
    // The refined insight carries the prior support forward + the refining evidence.
    expect(r.insight!.status).toBe("active");
    expect(r.insight!.evidence.map((e) => e.commentId)).toEqual(["c1", "c5"]);
    expect(r.insight!.evidence.at(-1)!.relation).toBe("refines");
  });

  it("contradict flags status but keeps the row and its evidence", () => {
    const list: Insight[] = [];
    const created = applySaveInsight(list, { statement: "s", evidence: [ev("d1", "c1")] }).insight!;
    const r = applySaveInsight(list, { targetId: created.id, relation: "contradict", evidence: [raw("d2", "c2")] });
    expect(r.ok).toBe(true);
    expect(created.status).toBe("contradicted");
    expect(list).toHaveLength(1); // not removed
    expect(created.evidence.at(-1)!.relation).toBe("contradicts");
    // A contradicted insight no longer blocks a create of the same statement.
    expect(similarActiveInsights(list, "s")).toHaveLength(0);
  });

  it("reinforce dedups evidence citing an already-linked thread", () => {
    const list: Insight[] = [];
    const created = applySaveInsight(list, { statement: "s", evidence: [ev("d1", "c1")] }).insight!;
    applySaveInsight(list, { updates: created.id, relation: "reinforces", evidence: [ev("d1", "c1")] });
    applySaveInsight(list, { updates: created.id, relation: "reinforces", evidence: [ev("d1", "c1")] });
    expect(created.evidence).toHaveLength(1); // same {docId, commentId} never doubled
  });

  it("refine runs the similarity gate against OTHER active insights", () => {
    const list: Insight[] = [];
    const target = applySaveInsight(list, { statement: "keep intros short", evidence: [ev("d1", "c1")] }).insight!;
    applySaveInsight(list, { statement: "prefer serif body type", evidence: [ev("d1", "c2")] }); // an unrelated active one
    // Refining the target toward a near-duplicate of a DIFFERENT active insight
    // trips the forced choice (the target itself is excluded).
    const clash = applySaveInsight(list, {
      updates: target.id,
      relation: "refines",
      statement: "prefer a serif body typeface",
      evidence: [raw("d1", "c3")],
    });
    expect(clash.ok).toBe(false);
    expect(clash.candidates).toHaveLength(1);
    expect(target.status).toBe("active"); // not retired — the refine was refused
  });

  it("accepts the cloud relation forms (new / updates) and rejects an over-long statement", () => {
    const list: Insight[] = [];
    const created = applySaveInsight(list, { relation: "new", statement: "warm intros win", evidence: [ev("d1", "c1")] });
    expect(created.ok).toBe(true);
    expect(created.relation).toBe("new");
    const r = applySaveInsight(list, { updates: created.insight!.id, relation: "reinforces", evidence: [ev("d1", "c9")] });
    expect(r.relation).toBe("reinforces");
    const long = applySaveInsight(list, { statement: "x".repeat(141), evidence: [ev("d1", "c1")] });
    expect(long.ok).toBe(false);
    expect(long.error).toMatch(/140/);
  });
});

describe("markDirtyForThread", () => {
  it("flags only insights citing the thread, and reports no change on a no-op", () => {
    const list: Insight[] = [];
    const a = applySaveInsight(list, { statement: "a", evidence: [ev("d1", "c1")] }).insight!;
    applySaveInsight(list, { statement: "b", evidence: [ev("d1", "c9")] });

    const first = markDirtyForThread(list, "d1", ["c1", "c1r1"]);
    expect(first.changed).toBe(true);
    expect(first.citing).toEqual([a.id]);
    expect(a.evidenceDirty).toBe(true);

    // Already dirty → cites it but nothing changed.
    const second = markDirtyForThread(list, "d1", ["c1"]);
    expect(second.citing).toEqual([a.id]);
    expect(second.changed).toBe(false);

    // A thread nobody cites → no citing, no change.
    const none = markDirtyForThread(list, "d1", ["c404"]);
    expect(none.citing).toEqual([]);
    expect(none.changed).toBe(false);
  });

  it("never dirties a retired (refined-away) row", () => {
    const list: Insight[] = [];
    const old = applySaveInsight(list, { statement: "green means shipped", evidence: [ev("d1", "c1")] }).insight!;
    // Refine retires `old`, carrying its evidence (c1) forward to the new row.
    const refined = applySaveInsight(list, {
      updates: old.id,
      relation: "refines",
      statement: "green means shipped and claimed",
      evidence: [raw("d1", "c1")],
    }).insight!;
    expect(old.status).toBe("retired");

    const r = markDirtyForThread(list, "d1", ["c1"]);
    // The retired row must never resurface; only the active refined row is cited.
    expect(r.citing).toEqual([refined.id]);
    expect(old.evidenceDirty).toBe(false);
  });
});

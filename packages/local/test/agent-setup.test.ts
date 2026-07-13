import { describe, expect, it } from "vitest";
import { upsertClaudeMdBlock } from "../src/agent-setup";

const START = "<!-- marigold-draft:start";
const END = "<!-- marigold-draft:end -->";

describe("upsertClaudeMdBlock", () => {
  it("creates the block in an empty file", () => {
    const out = upsertClaudeMdBlock("");
    expect(out).not.toBeNull();
    expect(out!.startsWith(START)).toBe(true);
    expect(out).toContain("Present work for review as Marigold Drafts");
    expect(out!.trimEnd().endsWith(END)).toBe(true);
  });

  it("appends after existing content with a blank-line separator", () => {
    const out = upsertClaudeMdBlock("# my rules\n\nuse tabs\n");
    expect(out).not.toBeNull();
    expect(out!.startsWith("# my rules")).toBe(true);
    expect(out).toContain("use tabs\n\n" + START);
  });

  it("is idempotent — re-running produces the same body", () => {
    const once = upsertClaudeMdBlock("# my rules\n")!;
    const twice = upsertClaudeMdBlock(once)!;
    expect(twice).toBe(once);
    // exactly one block
    expect(twice.split(START).length - 1).toBe(1);
  });

  it("refreshes a stale block in place, preserving surrounding content", () => {
    const stale = `before\n\n${START} — managed by \`marigold-draft agent-setup\`; delete this block to opt out -->\nOLD CONTENT\n${END}\n\nafter\n`;
    const out = upsertClaudeMdBlock(stale)!;
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("OLD CONTENT");
    expect(out).toContain("Present work for review as Marigold Drafts");
    expect(out.split(START).length - 1).toBe(1);
  });

  it("refuses to touch a file with a start marker but no end marker", () => {
    const broken = `${START} — managed -->\nsomething the user hand-edited\n`;
    expect(upsertClaudeMdBlock(broken)).toBeNull();
  });
});

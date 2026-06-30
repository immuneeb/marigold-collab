import { describe, expect, it } from "vitest";
import { roleCan } from "../src/acl";

describe("roleCan (v1 capability matrix)", () => {
  it("owner can do everything", () => {
    for (const a of [
      "view",
      "comment",
      "update",
      "publish",
      "manage",
      "delete",
    ] as const) {
      expect(roleCan("owner", a)).toBe(true);
    }
  });

  it("editor can update/publish/comment but not manage/delete", () => {
    expect(roleCan("editor", "update")).toBe(true);
    expect(roleCan("editor", "publish")).toBe(true);
    expect(roleCan("editor", "comment")).toBe(true);
    expect(roleCan("editor", "manage")).toBe(false);
    expect(roleCan("editor", "delete")).toBe(false);
  });

  it("commenter can comment + view, not update", () => {
    expect(roleCan("commenter", "view")).toBe(true);
    expect(roleCan("commenter", "comment")).toBe(true);
    expect(roleCan("commenter", "update")).toBe(false);
  });

  it("viewer can only view", () => {
    expect(roleCan("viewer", "view")).toBe(true);
    expect(roleCan("viewer", "comment")).toBe(false);
    expect(roleCan("viewer", "update")).toBe(false);
    expect(roleCan("viewer", "manage")).toBe(false);
  });
});

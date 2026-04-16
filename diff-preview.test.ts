import { describe, test } from "node:test";
import { applyEditBlocksToContent } from "./diff-preview";

describe("applyEditBlocksToContent", () => {
  test("applies multiple non-overlapping blocks from bottom to top", () => {
    const input = ["start", "alpha", "beta", "end"].join("\n");
    const result = applyEditBlocksToContent(input, [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "beta", newText: "BETA" },
    ]);

    expect(result).toEqual({
      ok: true,
      afterText: ["start", "ALPHA", "BETA", "end"].join("\n"),
    });
  });

  test("fails when an edit block matches multiple locations", () => {
    const result = applyEditBlocksToContent("x\nrepeat\nrepeat\nz", [{ oldText: "repeat", newText: "changed" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("multiple locations");
  });

  test("fails when edit blocks overlap", () => {
    const result = applyEditBlocksToContent("abcdef", [
      { oldText: "abcd", newText: "ABCD" },
      { oldText: "bc", newText: "BC" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("overlap");
  });
});

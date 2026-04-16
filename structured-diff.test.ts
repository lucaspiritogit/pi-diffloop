import { describe, test } from "node:test";
import { adjustStructuredDiffContext, buildStructuredDiff } from "./structured-diff";

describe("buildStructuredDiff", () => {
  test("creates a replace row with inline highlight ranges", () => {
    const diff = buildStructuredDiff("const value = 1;\n", "const value = 2;\n");

    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0]?.kind).toBe("replace");
    expect(diff.rows[0]?.oldLineNumber).toBe(1);
    expect(diff.rows[0]?.newLineNumber).toBe(1);
    expect((diff.rows[0]?.oldHighlights.length ?? 0) > 0).toBe(true);
    expect((diff.rows[0]?.newHighlights.length ?? 0) > 0).toBe(true);
  });

  test("builds hunk and gap visibility metadata around changed rows", () => {
    const before = ["alpha", "beta", "gamma", "delta", "omega"].join("\n") + "\n";
    const after = ["alpha", "beta", "GAMMA", "delta", "omega"].join("\n") + "\n";
    const diff = buildStructuredDiff(before, after, 0);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.visibleItems.some((item) => item.type === "gap")).toBe(true);
    const changedRows = diff.visibleItems.filter((item) => item.type === "row" && item.row.kind !== "equal");
    expect(changedRows).toHaveLength(1);
  });
});

describe("adjustStructuredDiffContext", () => {
  test("expands visible rows when context increases", () => {
    const before = ["one", "two", "three", "four", "five", "six"].join("\n") + "\n";
    const after = ["one", "two", "THREE", "four", "five", "six"].join("\n") + "\n";
    const minimal = buildStructuredDiff(before, after, 0);
    const expanded = adjustStructuredDiffContext(minimal, 2);

    const minimalRows = minimal.visibleItems.filter((item) => item.type === "row").length;
    const expandedRows = expanded.visibleItems.filter((item) => item.type === "row").length;
    expect(expandedRows > minimalRows).toBe(true);
  });
});

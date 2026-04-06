import { describe, expect, test } from "bun:test";
import { buildUnifiedDiffPreview } from "./diff-preview";

describe("buildUnifiedDiffPreview", () => {
	test("returns a unified diff with hunk and +/- stats", () => {
		const diff = buildUnifiedDiffPreview("one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n", {
			beforeLabel: "before",
			afterLabel: "after",
			contextLines: 1,
		});

		expect(diff.hasChanges).toBe(true);
		expect(diff.hunks).toBe(1);
		expect(diff.additions).toBe(2);
		expect(diff.removals).toBe(1);
		expect(diff.lines).toEqual([
			{ kind: "meta", text: "@@ -1,3 +1,4 @@" },
			{ kind: "context", text: " one" },
			{ kind: "remove", text: "-two" },
			{ kind: "add", text: "+TWO" },
			{ kind: "context", text: " three" },
			{ kind: "add", text: "+four" },
		]);
	});

	test("returns a no-op preview when content is unchanged", () => {
		expect(buildUnifiedDiffPreview("same\n", "same\n")).toEqual({
			lines: [{ kind: "meta", text: "No textual changes to preview." }],
			additions: 0,
			removals: 0,
			hunks: 0,
			hasChanges: false,
		});
	});
});

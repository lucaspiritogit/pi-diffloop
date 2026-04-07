export type DiffPreviewLineKind = "meta" | "context" | "add" | "remove" | "warning";

export type DiffPreviewLine = {
	kind: DiffPreviewLineKind;
	text: string;
};

export type DiffPreview = {
	lines: DiffPreviewLine[];
	additions: number;
	removals: number;
	hunks: number;
	hasChanges: boolean;
};

type DiffOp =
	| { type: "equal"; line: string }
	| { type: "add"; line: string }
	| { type: "remove"; line: string };

function splitLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function buildDiffOps(before: string[], after: string[]): DiffOp[] {
	const n = before.length;
	const m = after.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			if (before[i] === after[j]) {
				lcs[i]![j] = 1 + lcs[i + 1]![j + 1]!;
			} else {
				lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
			}
		}
	}

	const ops: DiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			ops.push({ type: "equal", line: before[i]! });
			i++;
			j++;
			continue;
		}

		if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
			ops.push({ type: "remove", line: before[i]! });
			i++;
		} else {
			ops.push({ type: "add", line: after[j]! });
			j++;
		}
	}

	while (i < n) {
		ops.push({ type: "remove", line: before[i]! });
		i++;
	}

	while (j < m) {
		ops.push({ type: "add", line: after[j]! });
		j++;
	}

	return ops;
}

type AnnotatedOp = DiffOp & { oldLine: number; newLine: number };

function annotateOps(ops: DiffOp[]): AnnotatedOp[] {
	const annotated: AnnotatedOp[] = [];
	let oldLine = 1;
	let newLine = 1;

	for (const op of ops) {
		annotated.push({ ...op, oldLine, newLine });
		if (op.type !== "add") oldLine++;
		if (op.type !== "remove") newLine++;
	}

	return annotated;
}

function buildHunkRanges(ops: AnnotatedOp[], contextLines: number): Array<{ start: number; end: number }> {
	const changeIndices = ops
		.map((op, index) => (op.type === "equal" ? -1 : index))
		.filter((index) => index >= 0);

	if (changeIndices.length === 0) return [];

	const ranges: Array<{ start: number; end: number }> = [];
	for (const index of changeIndices) {
		const start = Math.max(0, index - contextLines);
		const end = Math.min(ops.length - 1, index + contextLines);
		const last = ranges[ranges.length - 1];
		if (!last || start > last.end + 1) {
			ranges.push({ start, end });
		} else {
			last.end = Math.max(last.end, end);
		}
	}

	return ranges;
}

export function buildUnifiedDiffPreview(
	before: string,
	after: string,
	options?: {
		beforeLabel?: string;
		afterLabel?: string;
		contextLines?: number;
	},
): DiffPreview {
	if (before === after) {
		return {
			lines: [{ kind: "meta", text: "No textual changes to preview." }],
			additions: 0,
			removals: 0,
			hunks: 0,
			hasChanges: false,
		};
	}

	const contextLines = options?.contextLines ?? 3;
	const ops = annotateOps(buildDiffOps(splitLines(before), splitLines(after)));
	const ranges = buildHunkRanges(ops, contextLines);

	let additions = 0;
	let removals = 0;
	const lines: DiffPreviewLine[] = [];

	for (const range of ranges) {
		const hunkOps = ops.slice(range.start, range.end + 1);
		if (hunkOps.length === 0) continue;

		const first = hunkOps[0]!;
		const oldCount = hunkOps.filter((op) => op.type !== "add").length;
		const newCount = hunkOps.filter((op) => op.type !== "remove").length;
		lines.push({ kind: "meta", text: `@@ -${first.oldLine},${oldCount} +${first.newLine},${newCount} @@` });

		for (const op of hunkOps) {
			if (op.type === "equal") {
				lines.push({ kind: "context", text: ` ${op.line}` });
				continue;
			}
			if (op.type === "remove") {
				removals++;
				lines.push({ kind: "remove", text: `-${op.line}` });
				continue;
			}
			additions++;
			lines.push({ kind: "add", text: `+${op.line}` });
		}
	}

	return {
		lines,
		additions,
		removals,
		hunks: ranges.length,
		hasChanges: additions > 0 || removals > 0,
	};
}

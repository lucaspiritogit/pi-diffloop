import { createTwoFilesPatch } from "diff";

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

	const patch = createTwoFilesPatch(
		options?.beforeLabel ?? "before",
		options?.afterLabel ?? "after",
		before,
		after,
		"",
		"",
		{ context: options?.contextLines ?? 3 },
	);

	const lines: DiffPreviewLine[] = [];
	let additions = 0;
	let removals = 0;
	let hunks = 0;

	for (const line of patch.replace(/\n$/, "").split("\n")) {
		if (!line || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("===")) continue;

		if (line.startsWith("@@")) {
			hunks++;
			lines.push({ kind: "meta", text: line });
			continue;
		}

		if (line.startsWith("+") && !line.startsWith("+++")) {
			additions++;
			lines.push({ kind: "add", text: line });
			continue;
		}

		if (line.startsWith("-") && !line.startsWith("---")) {
			removals++;
			lines.push({ kind: "remove", text: line });
			continue;
		}

		if (line.startsWith("\\ ")) {
			lines.push({ kind: "meta", text: line });
			continue;
		}

		lines.push({ kind: "context", text: line });
	}

	return {
		lines,
		additions,
		removals,
		hunks,
		hasChanges: additions > 0 || removals > 0,
	};
}

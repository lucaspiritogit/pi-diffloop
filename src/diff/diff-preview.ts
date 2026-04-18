import { createEditToolDefinition, createWriteToolDefinition } from "@mariozechner/pi-coding-agent";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import type { DiffPreviewLine, EditBlock, NativeEditBlockStatus, NativeEditPreviewResult } from "../review/review-types.js";

type NativeWritePreviewResult = { ok: true } | { ok: false; error: string };

type PlannedEdit = {
  index: number;
  matchLength: number;
  newText: string;
};

type EditApplicationResult = { ok: true; afterText: string } | { ok: false; error: string };

function countOccurrences(content: string, target: string): number {
  if (target.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const idx = content.indexOf(target, offset);
    if (idx === -1) break;
    count++;
    offset = idx + target.length;
  }
  return count;
}

export function applyEditBlocksToContent(content: string, edits: EditBlock[]): EditApplicationResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "No edit blocks were provided." };
  }

  const planned: PlannedEdit[] = [];
  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      return { ok: false, error: `Edit block ${index + 1} is missing oldText/newText.` };
    }

    if (edit.oldText.length === 0) {
      return { ok: false, error: `Edit block ${index + 1} has an empty oldText.` };
    }

    const firstIndex = content.indexOf(edit.oldText);
    if (firstIndex === -1) {
      return { ok: false, error: `Edit block ${index + 1} oldText was not found in the target content.` };
    }

    const occurrences = countOccurrences(content, edit.oldText);
    if (occurrences > 1) {
      return { ok: false, error: `Edit block ${index + 1} oldText matched multiple locations.` };
    }

    planned.push({
      index: firstIndex,
      matchLength: edit.oldText.length,
      newText: edit.newText,
    });
  }

  const sorted = [...planned].sort((a, b) => a.index - b.index);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (current.index < previous.index + previous.matchLength) {
      return { ok: false, error: "Some edit blocks overlap the same region." };
    }
  }

  let next = content;
  for (const edit of [...sorted].sort((a, b) => b.index - a.index)) {
    next = next.slice(0, edit.index) + edit.newText + next.slice(edit.index + edit.matchLength);
  }

  return { ok: true, afterText: next };
}

export async function runNativeEditPreview(cwd: string, path: string, edits: EditBlock[]): Promise<NativeEditPreviewResult> {
  const nativeEdit = createEditToolDefinition(cwd, {
    operations: {
      async access(absolutePath: string) {
        await access(absolutePath, constants.R_OK | constants.W_OK);
      },
      async readFile(absolutePath: string) {
        return readFile(absolutePath);
      },
      async writeFile(_absolutePath: string, _content: string) {
        // Prevent disk writes during preview. Native edit still computes details.diff.
      },
    },
  });

  try {
    const result = await nativeEdit.execute("diffloop-native-preview", { path, edits }, undefined, undefined, undefined as any);
    return {
      ok: true,
      diff: result.details?.diff,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runNativeWritePreview(cwd: string, path: string, content: string): Promise<NativeWritePreviewResult> {
  const nativeWrite = createWriteToolDefinition(cwd, {
    operations: {
      async mkdir(_dir: string) {
        // Preview only; directory creation is skipped.
      },
      async writeFile(_absolutePath: string, _content: string) {
        // Preview only; disk writes are intentionally skipped.
      },
    },
  });

  try {
    await nativeWrite.execute("diffloop-native-write-preview", { path, content }, undefined, undefined, undefined as any);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildPreviewFromNativeEditDiff(diff: string) {
  const lines: DiffPreviewLine[] = [];
  let additions = 0;
  let removals = 0;
  let hunks = 0;

  for (const line of diff.replace(/\n$/, "").split("\n")) {
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

  if (lines.length === 0) {
    lines.push({ kind: "meta", text: "No textual changes to preview." });
  }

  return {
    lines,
    additions,
    removals,
    hunks,
    hasChanges: additions > 0 || removals > 0,
  };
}

export function buildWriteContentPreview(content: string): DiffPreviewLine[] {
  if (content.length === 0) {
    return [{ kind: "meta", text: "(empty file)" }];
  }

  const lines = content.split("\n");
  return lines.map((line) => ({ kind: "add", text: `+${line}` }));
}

export async function getNativeEditBlockStatuses(
  cwd: string,
  path: string,
  edits: EditBlock[],
): Promise<NativeEditBlockStatus[]> {
  return Promise.all(
    edits.map(async (edit, index): Promise<NativeEditBlockStatus> => {
      const preview = await runNativeEditPreview(cwd, path, [edit]);
      if (preview.ok) {
        return { index, ok: true };
      }

      return {
        index,
        ok: false,
        kind: classifyNativeEditError(preview.error),
        error: preview.error,
      };
    }),
  );
}

function classifyNativeEditError(error: string): NativeEditBlockStatus["kind"] {
  if (error.includes("must be unique") || error.includes("must be empty") || error.includes("occurrences")) {
    return "notUnique";
  }
  if (error.includes("Could not find") || error.includes("File not found")) {
    return "notFound";
  }
  return "invalid";
}

export function buildEditValidationErrors(blockStatuses: NativeEditBlockStatus[], previewError?: string): string[] {
  const notFound = blockStatuses.filter((status) => !status.ok && status.kind === "notFound").length;
  const notUnique = blockStatuses.filter((status) => !status.ok && status.kind === "notUnique").length;
  const invalid = blockStatuses.filter((status) => !status.ok && status.kind === "invalid").length;

  const errors: string[] = [];
  if (notFound > 0) {
    if (previewError && notUnique === 0 && invalid === 0) {
      errors.push(previewError);
    } else {
      errors.push(`${notFound} block(s) did not match the current file content.`);
    }
  }
  if (notUnique > 0) {
    errors.push(`${notUnique} block(s) matched multiple locations; oldText must be unique.`);
  }
  if (invalid > 0) {
    errors.push(`${invalid} block(s) were rejected by native preview validation.`);
  }
  if (previewError && (notUnique > 0 || invalid > 0 || notFound === 0)) {
    errors.push(previewError);
  }

  return errors;
}

export function buildNativePreviewWarnings(status: NativeEditBlockStatus): DiffPreviewLine[] {
  if (status.ok) return [];
  if (status.kind === "notFound") {
    return [
      {
        kind: "warning",
        text: `! Edit block ${status.index + 1} oldText was not found by Pi's native edit tool.`,
      },
    ];
  }
  if (status.kind === "notUnique") {
    return [
      {
        kind: "warning",
        text: `! Edit block ${status.index + 1} oldText is not unique in the current file and will fail at execution time.`,
      },
    ];
  }
  return [
    {
      kind: "warning",
      text: `! Edit block ${status.index + 1} could not be validated by Pi: ${status.error}`,
    },
  ];
}

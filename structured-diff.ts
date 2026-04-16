import * as Diff from "diff";

export type StructuredDiffRowKind = "equal" | "insert" | "delete" | "replace";

export type InlineRange = {
  start: number;
  end: number;
};

export type StructuredDiffRow = {
  kind: StructuredDiffRowKind;
  oldLineNumber?: number;
  newLineNumber?: number;
  oldText: string;
  newText: string;
  oldHighlights: InlineRange[];
  newHighlights: InlineRange[];
};

export type StructuredDiffVisibleRow = {
  type: "row";
  fullRowIndex: number;
  row: StructuredDiffRow;
};

export type StructuredDiffGap = {
  type: "gap";
  beforeRowIndex: number;
  afterRowIndex: number;
  hiddenRowCount: number;
  hiddenOldLines: number;
  hiddenNewLines: number;
};

export type StructuredDiffVisibleItem = StructuredDiffVisibleRow | StructuredDiffGap;

export type StructuredDiffHunk = {
  index: number;
  displayStartRow: number;
  displayEndRow: number;
  changeStartRow: number;
  changeEndRow: number;
  oldStartLine?: number;
  oldEndLine?: number;
  newStartLine?: number;
  newEndLine?: number;
  additions: number;
  deletions: number;
};

export type StructuredDiff = {
  rows: StructuredDiffRow[];
  visibleItems: StructuredDiffVisibleItem[];
  hunks: StructuredDiffHunk[];
  additions: number;
  deletions: number;
  contextLines: number;
  totalOldLines: number;
  totalNewLines: number;
  firstChangedLine: number | undefined;
};

const DISPLAY_TAB = "    ";
const INLINE_HIGHLIGHT_CHAR_LIMIT = 800;

function countLogicalLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function normalizeDisplayText(text: string): string {
  return text.replace(/\t/g, DISPLAY_TAB);
}

function splitDiffLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map(normalizeDisplayText);
}

function charLength(text: string): number {
  return Array.from(text).length;
}

function fullHighlight(text: string): InlineRange[] {
  const length = charLength(text);
  return length > 0 ? [{ start: 0, end: length }] : [];
}

function coalesceRanges(ranges: InlineRange[]): InlineRange[] {
  if (ranges.length <= 1) return ranges;

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: InlineRange[] = [];

  for (const range of sorted) {
    const clamped = {
      start: Math.max(0, range.start),
      end: Math.max(0, range.end),
    };
    if (clamped.end <= clamped.start) continue;

    const previous = merged[merged.length - 1];
    if (!previous || clamped.start > previous.end) {
      merged.push(clamped);
      continue;
    }

    previous.end = Math.max(previous.end, clamped.end);
  }

  return merged;
}

function computeInlineHighlights(oldText: string, newText: string): { oldHighlights: InlineRange[]; newHighlights: InlineRange[] } {
  if (oldText.length === 0) {
    return { oldHighlights: [], newHighlights: fullHighlight(newText) };
  }
  if (newText.length === 0) {
    return { oldHighlights: fullHighlight(oldText), newHighlights: [] };
  }
  if (oldText === newText) {
    return { oldHighlights: [], newHighlights: [] };
  }
  if (oldText.length + newText.length > INLINE_HIGHLIGHT_CHAR_LIMIT) {
    return { oldHighlights: fullHighlight(oldText), newHighlights: fullHighlight(newText) };
  }

  const changes = Diff.diffChars(oldText, newText);
  const oldHighlights: InlineRange[] = [];
  const newHighlights: InlineRange[] = [];
  let oldOffset = 0;
  let newOffset = 0;

  for (const change of changes) {
    const length = charLength(change.value);
    if (change.added) {
      newHighlights.push({ start: newOffset, end: newOffset + length });
      newOffset += length;
      continue;
    }
    if (change.removed) {
      oldHighlights.push({ start: oldOffset, end: oldOffset + length });
      oldOffset += length;
      continue;
    }

    oldOffset += length;
    newOffset += length;
  }

  return {
    oldHighlights: coalesceRanges(oldHighlights),
    newHighlights: coalesceRanges(newHighlights),
  };
}

function createRow(
  kind: StructuredDiffRowKind,
  oldLineNumber: number | undefined,
  newLineNumber: number | undefined,
  oldText: string,
  newText: string,
): StructuredDiffRow {
  const highlights =
    kind === "replace"
      ? computeInlineHighlights(oldText, newText)
      : {
        oldHighlights: kind === "delete" ? fullHighlight(oldText) : [],
        newHighlights: kind === "insert" ? fullHighlight(newText) : [],
      };

  return {
    kind,
    oldLineNumber,
    newLineNumber,
    oldText,
    newText,
    oldHighlights: highlights.oldHighlights,
    newHighlights: highlights.newHighlights,
  };
}

function buildAlignedRows(oldContent: string, newContent: string): {
  rows: StructuredDiffRow[];
  totalOldLines: number;
  totalNewLines: number;
} {
  const parts = Diff.diffLines(oldContent, newContent);
  const rows: StructuredDiffRow[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];

    if (part.removed && next?.added) {
      const removedLines = splitDiffLines(part.value);
      const addedLines = splitDiffLines(next.value);
      const count = Math.max(removedLines.length, addedLines.length);

      for (let j = 0; j < count; j++) {
        const oldText = removedLines[j];
        const newText = addedLines[j];
        if (oldText !== undefined && newText !== undefined) {
          rows.push(createRow("replace", oldLineNumber, newLineNumber, oldText, newText));
          oldLineNumber++;
          newLineNumber++;
          continue;
        }
        if (oldText !== undefined) {
          rows.push(createRow("delete", oldLineNumber, undefined, oldText, ""));
          oldLineNumber++;
          continue;
        }
        if (newText !== undefined) {
          rows.push(createRow("insert", undefined, newLineNumber, "", newText));
          newLineNumber++;
        }
      }

      i++;
      continue;
    }

    if (part.added && next?.removed) {
      const addedLines = splitDiffLines(part.value);
      const removedLines = splitDiffLines(next.value);
      const count = Math.max(removedLines.length, addedLines.length);

      for (let j = 0; j < count; j++) {
        const oldText = removedLines[j];
        const newText = addedLines[j];
        if (oldText !== undefined && newText !== undefined) {
          rows.push(createRow("replace", oldLineNumber, newLineNumber, oldText, newText));
          oldLineNumber++;
          newLineNumber++;
          continue;
        }
        if (oldText !== undefined) {
          rows.push(createRow("delete", oldLineNumber, undefined, oldText, ""));
          oldLineNumber++;
          continue;
        }
        if (newText !== undefined) {
          rows.push(createRow("insert", undefined, newLineNumber, "", newText));
          newLineNumber++;
        }
      }

      i++;
      continue;
    }

    if (part.removed) {
      for (const line of splitDiffLines(part.value)) {
        rows.push(createRow("delete", oldLineNumber, undefined, line, ""));
        oldLineNumber++;
      }
      continue;
    }

    if (part.added) {
      for (const line of splitDiffLines(part.value)) {
        rows.push(createRow("insert", undefined, newLineNumber, "", line));
        newLineNumber++;
      }
      continue;
    }

    for (const line of splitDiffLines(part.value)) {
      rows.push(createRow("equal", oldLineNumber, newLineNumber, line, line));
      oldLineNumber++;
      newLineNumber++;
    }
  }

  return {
    rows,
    totalOldLines: Math.max(countLogicalLines(oldContent), oldLineNumber - 1),
    totalNewLines: Math.max(countLogicalLines(newContent), newLineNumber - 1),
  };
}

function getLineRange(
  rows: StructuredDiffRow[],
  startRow: number,
  endRow: number,
  side: "old" | "new",
): { start?: number; end?: number } {
  let startLine: number | undefined;
  let endLine: number | undefined;

  for (let i = startRow; i <= endRow; i++) {
    const row = rows[i]!;
    const lineNumber = side === "old" ? row.oldLineNumber : row.newLineNumber;
    if (lineNumber === undefined) continue;
    if (startLine === undefined) startLine = lineNumber;
    endLine = lineNumber;
  }

  return { start: startLine, end: endLine };
}

function buildStructuredDiffFromRows(
  rows: StructuredDiffRow[],
  totalOldLines: number,
  totalNewLines: number,
  contextLines: number,
): StructuredDiff {
  const additions = rows.reduce((count, row) => count + (row.kind === "insert" || row.kind === "replace" ? 1 : 0), 0);
  const deletions = rows.reduce((count, row) => count + (row.kind === "delete" || row.kind === "replace" ? 1 : 0), 0);

  type ChangeBlock = { start: number; end: number };
  const changeBlocks: ChangeBlock[] = [];
  let blockStart: number | undefined;

  for (let i = 0; i < rows.length; i++) {
    const isChange = rows[i]!.kind !== "equal";
    if (isChange) {
      blockStart ??= i;
      continue;
    }

    if (blockStart !== undefined) {
      changeBlocks.push({ start: blockStart, end: i - 1 });
      blockStart = undefined;
    }
  }

  if (blockStart !== undefined) {
    changeBlocks.push({ start: blockStart, end: rows.length - 1 });
  }

  if (changeBlocks.length === 0) {
    return {
      rows,
      visibleItems: rows.map((row, fullRowIndex) => ({ type: "row", fullRowIndex, row })),
      hunks: [],
      additions,
      deletions,
      contextLines,
      totalOldLines,
      totalNewLines,
      firstChangedLine: undefined,
    };
  }

  type HunkSeed = {
    displayStartRow: number;
    displayEndRow: number;
    changeStartRow: number;
    changeEndRow: number;
  };

  const seeds: HunkSeed[] = [];
  for (const block of changeBlocks) {
    const displayStartRow = Math.max(0, block.start - contextLines);
    const displayEndRow = Math.min(rows.length - 1, block.end + contextLines);
    const previous = seeds[seeds.length - 1];

    if (previous && displayStartRow <= previous.displayEndRow + 1) {
      previous.displayEndRow = Math.max(previous.displayEndRow, displayEndRow);
      previous.changeEndRow = block.end;
      continue;
    }

    seeds.push({
      displayStartRow,
      displayEndRow,
      changeStartRow: block.start,
      changeEndRow: block.end,
    });
  }

  const hunks: StructuredDiffHunk[] = seeds.map((seed, index) => {
    const oldRange = getLineRange(rows, seed.changeStartRow, seed.changeEndRow, "old");
    const newRange = getLineRange(rows, seed.changeStartRow, seed.changeEndRow, "new");
    let hunkAdditions = 0;
    let hunkDeletions = 0;

    for (let rowIndex = seed.changeStartRow; rowIndex <= seed.changeEndRow; rowIndex++) {
      const row = rows[rowIndex]!;
      if (row.kind === "insert" || row.kind === "replace") hunkAdditions++;
      if (row.kind === "delete" || row.kind === "replace") hunkDeletions++;
    }

    return {
      index,
      displayStartRow: seed.displayStartRow,
      displayEndRow: seed.displayEndRow,
      changeStartRow: seed.changeStartRow,
      changeEndRow: seed.changeEndRow,
      oldStartLine: oldRange.start,
      oldEndLine: oldRange.end,
      newStartLine: newRange.start,
      newEndLine: newRange.end,
      additions: hunkAdditions,
      deletions: hunkDeletions,
    };
  });

  const visibleItems: StructuredDiffVisibleItem[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.displayStartRow > cursor) {
      const hiddenRowCount = hunk.displayStartRow - cursor;
      visibleItems.push({
        type: "gap",
        beforeRowIndex: cursor - 1,
        afterRowIndex: hunk.displayStartRow,
        hiddenRowCount,
        hiddenOldLines: hiddenRowCount,
        hiddenNewLines: hiddenRowCount,
      });
    }

    for (let rowIndex = hunk.displayStartRow; rowIndex <= hunk.displayEndRow; rowIndex++) {
      visibleItems.push({
        type: "row",
        fullRowIndex: rowIndex,
        row: rows[rowIndex]!,
      });
    }

    cursor = hunk.displayEndRow + 1;
  }

  if (cursor < rows.length) {
    const hiddenRowCount = rows.length - cursor;
    visibleItems.push({
      type: "gap",
      beforeRowIndex: cursor - 1,
      afterRowIndex: rows.length,
      hiddenRowCount,
      hiddenOldLines: hiddenRowCount,
      hiddenNewLines: hiddenRowCount,
    });
  }

  const firstHunk = hunks[0];
  const firstChangedLine = firstHunk ? (firstHunk.newStartLine ?? firstHunk.oldStartLine) : undefined;

  return {
    rows,
    visibleItems,
    hunks,
    additions,
    deletions,
    contextLines,
    totalOldLines,
    totalNewLines,
    firstChangedLine,
  };
}

export function buildStructuredDiff(oldContent: string, newContent: string, contextLines = 4): StructuredDiff {
  const aligned = buildAlignedRows(oldContent, newContent);
  return buildStructuredDiffFromRows(aligned.rows, aligned.totalOldLines, aligned.totalNewLines, contextLines);
}

export function adjustStructuredDiffContext(diff: StructuredDiff, contextLines: number): StructuredDiff {
  return buildStructuredDiffFromRows(diff.rows, diff.totalOldLines, diff.totalNewLines, contextLines);
}

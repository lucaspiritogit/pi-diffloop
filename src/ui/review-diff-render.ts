import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { DiffPreviewLine, ReviewData } from "../review/review-types.js";
import type { InlineRange, StructuredDiff, StructuredDiffRow } from "../diff/structured-diff.js";
import { detectSyntaxLanguage, getSyntaxTokenColorAnsi, tokenizeSyntaxLine, type SyntaxSegment } from "../diff/syntax-highlight.js";
import { pushWrappedLine } from "../lib/utils.js";

const TAB_REPLACEMENT = "    ";

export type DiffViewMode = "split" | "inline";

type Theme = ExtensionContext["ui"]["theme"];

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function normalizeDiffText(text: string): string {
  return text.replace(/\t/g, TAB_REPLACEMENT);
}

function padAnsiRight(text: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(padding)}`;
}

function normalizeRanges(ranges: InlineRange[], maxLength: number): InlineRange[] {
  return ranges
    .map((range) => ({
      start: clampNumber(range.start, 0, maxLength),
      end: clampNumber(range.end, 0, maxLength),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function styleSegment(
  theme: Theme,
  text: string,
  tone: "dim" | "success" | "error",
  highlighted: boolean,
  token?: SyntaxSegment["token"],
): string {
  if (text.length === 0) return "";
  const tokenColor = getSyntaxTokenColorAnsi(token);
  const colored = tokenColor ? `${tokenColor}${text}\x1b[39m` : theme.fg(tone, text);
  if (!highlighted) return colored;
  return `\x1b[1m${colored}\x1b[22m`;
}

function styleDiffText(
  theme: Theme,
  text: string,
  ranges: InlineRange[],
  tone: "dim" | "success" | "error",
  syntaxLanguage: string | undefined,
): string {
  const normalized = normalizeDiffText(text);
  const chars = Array.from(normalized);
  if (chars.length === 0) return "";

  const safeRanges = normalizeRanges(ranges, chars.length);
  const syntaxSegments = tokenizeSyntaxLine(normalized, syntaxLanguage);
  type SyntaxRange = { start: number; end: number; token?: SyntaxSegment["token"] };
  const syntaxRanges: SyntaxRange[] = [];
  let syntaxCursor = 0;
  for (const segment of syntaxSegments) {
    const segmentLength = Array.from(segment.text).length;
    if (segmentLength === 0) continue;
    syntaxRanges.push({
      start: syntaxCursor,
      end: syntaxCursor + segmentLength,
      token: segment.token,
    });
    syntaxCursor += segmentLength;
  }

  const boundaries = new Set<number>([0, chars.length]);
  for (const range of safeRanges) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const range of syntaxRanges) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }

  const orderedBoundaries = [...boundaries].sort((a, b) => a - b);
  let highlightIndex = 0;
  let syntaxIndex = 0;
  let output = "";

  for (let i = 0; i < orderedBoundaries.length - 1; i++) {
    const start = orderedBoundaries[i]!;
    const end = orderedBoundaries[i + 1]!;
    if (end <= start) continue;

    while (highlightIndex < safeRanges.length && start >= safeRanges[highlightIndex]!.end) highlightIndex++;
    while (syntaxIndex < syntaxRanges.length && start >= syntaxRanges[syntaxIndex]!.end) syntaxIndex++;

    const highlighted =
      highlightIndex < safeRanges.length &&
      start >= safeRanges[highlightIndex]!.start &&
      start < safeRanges[highlightIndex]!.end;
    const token =
      syntaxIndex < syntaxRanges.length &&
      start >= syntaxRanges[syntaxIndex]!.start &&
      start < syntaxRanges[syntaxIndex]!.end
        ? syntaxRanges[syntaxIndex]!.token
        : undefined;

    output += styleSegment(theme, chars.slice(start, end).join(""), tone, highlighted, token);
  }

  return output;
}

function buildLinePrefix(
  theme: Theme,
  sign: " " | "+" | "-",
  lineNumber: number | undefined,
  lineNumberWidth: number,
  tone: "dim" | "success" | "error",
): string {
  const numberText = lineNumber === undefined ? "".padStart(lineNumberWidth, " ") : String(lineNumber).padStart(lineNumberWidth, " ");
  const signText = sign === " " ? sign : theme.bold(theme.fg(tone, sign));
  const lineText = sign === " " ? theme.fg("dim", numberText) : theme.bold(theme.fg(tone, numberText));
  return `${signText}${lineText} `;
}

function renderWrappedCell(
  theme: Theme,
  sign: " " | "+" | "-",
  lineNumber: number | undefined,
  text: string,
  ranges: InlineRange[],
  tone: "dim" | "success" | "error",
  width: number,
  lineNumberWidth: number,
  syntaxLanguage: string | undefined,
): string[] {
  const prefixWidth = lineNumberWidth + 2;
  const contentWidth = Math.max(1, width - prefixWidth);
  if (lineNumber === undefined && text.length === 0) {
    return [" ".repeat(width)];
  }

  const styled = styleDiffText(theme, text, ranges, tone, syntaxLanguage);
  const wrapped = wrapTextWithAnsi(styled, contentWidth).map((line) => truncateToWidth(line, contentWidth, "", false));
  const safeWrapped = wrapped.length > 0 ? wrapped : [""];
  const lines: string[] = [];

  for (let index = 0; index < safeWrapped.length; index++) {
    const prefix = index === 0 ? buildLinePrefix(theme, sign, lineNumber, lineNumberWidth, tone) : " ".repeat(prefixWidth);
    const line = truncateToWidth(`${prefix}${safeWrapped[index]}`, width, "", false);
    lines.push(padAnsiRight(line, width));
  }

  return lines;
}

function renderUnifiedRow(
  theme: Theme,
  row: StructuredDiffRow,
  width: number,
  lineNumberWidth: number,
  syntaxLanguage: string | undefined,
): string[] {
  if (row.kind === "equal") {
    return renderWrappedCell(theme, " ", row.oldLineNumber, row.oldText, [], "dim", width, lineNumberWidth, syntaxLanguage);
  }
  if (row.kind === "delete") {
    return renderWrappedCell(
      theme,
      "-",
      row.oldLineNumber,
      row.oldText,
      row.oldHighlights,
      "error",
      width,
      lineNumberWidth,
      syntaxLanguage,
    );
  }
  if (row.kind === "insert") {
    return renderWrappedCell(
      theme,
      "+",
      row.newLineNumber,
      row.newText,
      row.newHighlights,
      "success",
      width,
      lineNumberWidth,
      syntaxLanguage,
    );
  }

  return [
    ...renderWrappedCell(
      theme,
      "-",
      row.oldLineNumber,
      row.oldText,
      row.oldHighlights,
      "error",
      width,
      lineNumberWidth,
      syntaxLanguage,
    ),
    ...renderWrappedCell(
      theme,
      "+",
      row.newLineNumber,
      row.newText,
      row.newHighlights,
      "success",
      width,
      lineNumberWidth,
      syntaxLanguage,
    ),
  ];
}

function getSplitLayout(width: number, theme: Theme): { leftWidth: number; rightWidth: number; gutterText: string; gutterWidth: number } {
  const gutterText = theme.fg("borderMuted", " │ ");
  const gutterWidth = 3;
  const leftWidth = Math.floor((width - gutterWidth) / 2);
  const rightWidth = width - gutterWidth - leftWidth;
  return { leftWidth, rightWidth, gutterText, gutterWidth };
}

function renderSplitCell(
  theme: Theme,
  row: StructuredDiffRow,
  side: "old" | "new",
  width: number,
  lineNumberWidth: number,
  syntaxLanguage: string | undefined,
): string[] {
  if (side === "old") {
    if (row.kind === "insert") {
      return [" ".repeat(width)];
    }
    const sign: " " | "-" = row.kind === "equal" ? " " : "-";
    const tone: "dim" | "error" = row.kind === "equal" ? "dim" : "error";
    return renderWrappedCell(
      theme,
      sign,
      row.oldLineNumber,
      row.oldText,
      row.oldHighlights,
      tone,
      width,
      lineNumberWidth,
      syntaxLanguage,
    );
  }

  if (row.kind === "delete") {
    return [" ".repeat(width)];
  }
  const sign: " " | "+" = row.kind === "equal" ? " " : "+";
  const tone: "dim" | "success" = row.kind === "equal" ? "dim" : "success";
  return renderWrappedCell(
    theme,
    sign,
    row.newLineNumber,
    row.newText,
    row.newHighlights,
    tone,
    width,
    lineNumberWidth,
    syntaxLanguage,
  );
}

function renderStructuredDiffLines(
  diff: StructuredDiff,
  width: number,
  theme: Theme,
  mode: DiffViewMode,
  filePath: string,
): string[] {
  const safeWidth = Math.max(20, width);
  const lineNumberWidth = Math.max(1, String(Math.max(diff.totalOldLines, diff.totalNewLines, 1)).length);
  const syntaxLanguage = detectSyntaxLanguage(filePath);
  const lines: string[] = [];

  if (mode === "split") {
    const layout = getSplitLayout(safeWidth, theme);
    const leftTitle = padAnsiRight(
      truncateToWidth(theme.bold(theme.fg("dim", "Original")), layout.leftWidth, "", false),
      layout.leftWidth,
    );
    const rightTitle = padAnsiRight(
      truncateToWidth(theme.bold(theme.fg("dim", "Updated")), layout.rightWidth, "", false),
      layout.rightWidth,
    );
    lines.push(leftTitle + layout.gutterText + rightTitle);
    lines.push(
      theme.fg("borderMuted", `${"─".repeat(layout.leftWidth)}─┼─${"─".repeat(layout.rightWidth)}`),
    );

    for (const item of diff.visibleItems) {
      if (item.type === "gap") {
        continue;
      }

      const leftCell = renderSplitCell(theme, item.row, "old", layout.leftWidth, lineNumberWidth, syntaxLanguage);
      const rightCell = renderSplitCell(theme, item.row, "new", layout.rightWidth, lineNumberWidth, syntaxLanguage);
      const totalLines = Math.max(leftCell.length, rightCell.length);
      for (let index = 0; index < totalLines; index++) {
        const left = leftCell[index] ?? " ".repeat(layout.leftWidth);
        const right = rightCell[index] ?? " ".repeat(layout.rightWidth);
        lines.push(padAnsiRight(left, layout.leftWidth) + layout.gutterText + padAnsiRight(right, layout.rightWidth));
      }
    }
    return lines;
  }

  for (const item of diff.visibleItems) {
    if (item.type === "gap") {
      continue;
    }
    lines.push(...renderUnifiedRow(theme, item.row, safeWidth, lineNumberWidth, syntaxLanguage));
  }

  return lines;
}

function renderLegacyPreviewLine(
  line: { kind: "add" | "remove" | "warning" | "meta" | "context"; text: string },
  theme: Theme,
): string {
  return line.kind === "add"
    ? theme.fg("success", line.text)
    : line.kind === "remove"
      ? theme.fg("error", line.text)
      : line.kind === "warning"
        ? theme.fg("warning", line.text)
        : line.kind === "meta"
          ? theme.fg("accent", line.text)
          : theme.fg("dim", line.text);
}

export function buildReviewBodyLines(
  review: ReviewData,
  width: number,
  theme: ExtensionContext["ui"]["theme"],
  diffViewMode: DiffViewMode = "split",
): string[] {
  const lines: string[] = [];

  for (const item of review.summary) {
    pushWrappedLine(lines, width, theme.fg("dim", `• ${item}`));
  }
  if (review.summary.length) {
    lines.push("");
  }

  for (const change of review.changes) {
    pushWrappedLine(lines, width, theme.fg("accent", theme.bold(change.title)));
    if (change.diffModel) {
      const prefaceLines = change.lines.filter((line: DiffPreviewLine) => line.kind === "warning");
      for (const line of prefaceLines) {
        pushWrappedLine(lines, width, renderLegacyPreviewLine(line, theme));
      }

      if (prefaceLines.length > 0) {
        lines.push("");
      }

      lines.push(...renderStructuredDiffLines(change.diffModel, width, theme, diffViewMode, review.path));
      lines.push("");
      continue;
    }

    for (const line of change.lines) {
      pushWrappedLine(lines, width, renderLegacyPreviewLine(line, theme));
    }
    lines.push("");
  }

  if (lines.length === 0) {
    pushWrappedLine(lines, width, theme.fg("dim", "No changes to preview."));
  }

  return lines;
}

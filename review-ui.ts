import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { ReviewAction, ReviewData, ReviewDecision } from "./review-types";
import type { InlineRange, StructuredDiff, StructuredDiffRow } from "./structured-diff";
import { detectSyntaxLanguage, getSyntaxTokenColorAnsi, tokenizeSyntaxLine, type SyntaxSegment } from "./syntax-highlight";
import { pushLine, pushWrappedLine } from "./utils";

const TAB_REPLACEMENT = "    ";

type DiffViewMode = "split" | "inline";

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

function centerAnsiText(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const truncated = truncateToWidth(text, safeWidth, "", false);
  const padding = Math.max(0, safeWidth - visibleWidth(truncated));
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return `${" ".repeat(left)}${truncated}${" ".repeat(right)}`;
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
        lines.push(centerAnsiText(theme.fg("dim", item.label), safeWidth));
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
      lines.push(centerAnsiText(theme.fg("dim", item.label), safeWidth));
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

export async function handleReviewAction(ctx: ExtensionContext, review: ReviewData): Promise<ReviewDecision> {
  return ctx.ui.custom<ReviewDecision>(
    (tui, theme, _keybindings, done) => {
      const actions: ReviewAction[] = ["approve", "steer", "edit", "deny"];
      let selected = 0;
      let steeringMode = false;
      let steeringError: string | undefined;
      let focused = false;
      let diffViewMode: DiffViewMode = "split";
      let previewScrollOffset = 0;
      let lastContentLineCount = 0;
      let lastVisibleContentRows = 1;
      const steeringInput = new Input();

      const actionLabel = (action: ReviewAction) => {
        if (actions[selected] === action) {
          return theme.bg("selectedBg", theme.fg("text", action));
        }
        if (action === "approve") return theme.fg("success", action);
        if (action === "steer") return theme.fg("warning", action);
        if (action === "edit") return theme.fg("accent", action);
        return theme.fg("error", action);
      };

      const setSteeringMode = (enabled: boolean) => {
        steeringMode = enabled;
        steeringError = undefined;
        if (!enabled) {
          steeringInput.setValue("");
        }
        steeringInput.focused = enabled && focused;
      };

      const clampPreviewScroll = () => {
        const maxOffset = Math.max(0, lastContentLineCount - lastVisibleContentRows);
        previewScrollOffset = Math.max(0, Math.min(previewScrollOffset, maxOffset));
        return maxOffset;
      };

      const scrollPreview = (delta: number) => {
        const maxOffset = clampPreviewScroll();
        if (maxOffset === 0) return false;

        const nextOffset = Math.max(0, Math.min(previewScrollOffset + delta, maxOffset));
        if (nextOffset === previewScrollOffset) return false;

        previewScrollOffset = nextOffset;
        return true;
      };

      steeringInput.onSubmit = (value: string) => {
        const steering = value.trim();
        if (!steering) {
          steeringError = "Enter steering instructions or press Esc to cancel.";
          tui.requestRender();
          return;
        }
        done({ action: "steer", steering });
      };

      steeringInput.onEscape = () => {
        setSteeringMode(false);
        tui.requestRender();
      };

      const buildHeaderLines = (width: number) => {
        const headerLines: string[] = [];
        const innerWidth = Math.max(20, width - 2);
        const divider = theme.fg("borderAccent", "─".repeat(innerWidth));

        pushLine(headerLines, width, divider);
        pushWrappedLine(headerLines, width, theme.fg("dim", theme.bold(`Review ${review.toolName}: ${review.path}`)));
        pushWrappedLine(headerLines, width, theme.fg("accent", `Why: ${review.reason}`));
        headerLines.push("");

        return { headerLines, divider };
      };

      return {
        get focused() {
          return focused;
        },

        set focused(value: boolean) {
          focused = value;
          steeringInput.focused = steeringMode && value;
        },

        handleInput(data: string) {
          if (steeringMode) {
            steeringInput.handleInput(data);
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
            selected = (selected - 1 + actions.length) % actions.length;
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
            selected = (selected + 1) % actions.length;
            tui.requestRender();
            return;
          }

          if (data === "v" || data === "V") {
            diffViewMode = diffViewMode === "split" ? "inline" : "split";
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("up")) || data === "k") {
            if (scrollPreview(-1)) tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.down) || matchesKey(data, Key.shift("down")) || data === "j") {
            if (scrollPreview(1)) tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.pageUp)) {
            if (scrollPreview(-Math.max(1, lastVisibleContentRows - 1))) tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.pageDown)) {
            if (scrollPreview(Math.max(1, lastVisibleContentRows - 1))) tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.home)) {
            if (previewScrollOffset !== 0) {
              previewScrollOffset = 0;
              tui.requestRender();
            }
            return;
          }

          if (matchesKey(data, Key.end)) {
            const maxOffset = clampPreviewScroll();
            if (previewScrollOffset !== maxOffset) {
              previewScrollOffset = maxOffset;
              tui.requestRender();
            }
            return;
          }

          if (matchesKey(data, Key.enter)) {
            const action = actions[selected];
            if (action === "steer") {
              setSteeringMode(true);
              tui.requestRender();
              return;
            }

            done(action);
            return;
          }

          if (matchesKey(data, Key.escape)) {
            done("deny");
          }
        },

        invalidate() {
          steeringInput.invalidate();
        },

        render(width: number) {
          const { headerLines, divider } = buildHeaderLines(width);
          const bodyLines = buildReviewBodyLines(review, width, theme, diffViewMode);
          const contentLines = [...headerLines, ...bodyLines];

          const buildFooterLines = (hint: string) => {
            const lines: string[] = [];
            pushLine(
              lines,
              width,
              `${actionLabel("approve")} ${actionLabel("steer")}  ${actionLabel("edit")}  ${actionLabel("deny")}`,
            );
            pushWrappedLine(lines, width, theme.fg("dim", hint));
            if (steeringMode) {
              lines.push("");
              pushWrappedLine(lines, width, theme.fg("warning", theme.bold("Steering feedback")));
              pushWrappedLine(
                lines,
                width,
                theme.fg(
                  "dim",
                  "Describe what should change, what should stay the same, and any behavior constraints.",
                ),
              );
              lines.push(...steeringInput.render(width));
              if (steeringError) {
                pushWrappedLine(lines, width, theme.fg("warning", steeringError));
              }
            }
            pushLine(lines, width, divider);
            return lines;
          };

          let hint = steeringMode
            ? "Type steering feedback below • Enter send • Esc cancel"
            : `←/→ choose • ↑/↓ or j/k scroll • v view(${diffViewMode === "split" ? "side-by-side" : "inline"}) • Enter confirm • Esc deny`;

          let footerLines = buildFooterLines(hint);

          for (let i = 0; i < 2; i++) {
            const availableRows = Math.max(1, tui.terminal.rows - footerLines.length);
            lastContentLineCount = contentLines.length;
            lastVisibleContentRows = availableRows;
            const maxOffset = clampPreviewScroll();
            const isScrollable = maxOffset > 0;
            const visibleStart = previewScrollOffset + 1;
            const visibleEnd = Math.min(contentLines.length, previewScrollOffset + availableRows);

            const nextHint = steeringMode
              ? "Type steering feedback below • Enter send • Esc cancel"
              : isScrollable
                ? `←/→ choose • ↑/↓ or j/k scroll • v view(${diffViewMode === "split" ? "side-by-side" : "inline"}) • PgUp/PgDn page • Home/End jump (${visibleStart}-${visibleEnd}/${contentLines.length})`
                : `←/→ choose • v view(${diffViewMode === "split" ? "side-by-side" : "inline"}) • Enter confirm • Esc deny`;

            if (nextHint === hint) break;
            hint = nextHint;
            footerLines = buildFooterLines(hint);
          }

          const availableRows = Math.max(1, tui.terminal.rows - footerLines.length);
          lastContentLineCount = contentLines.length;
          lastVisibleContentRows = availableRows;
          clampPreviewScroll();

          const visibleContent = contentLines.slice(previewScrollOffset, previewScrollOffset + availableRows);
          return [...visibleContent, ...footerLines];
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
    },
  );
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
      const prefaceLines = change.lines.filter((line) => line.kind === "warning");
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

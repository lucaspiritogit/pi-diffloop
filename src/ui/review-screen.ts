import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey } from "@earendil-works/pi-tui";
import type { ReviewAction, ReviewData, ReviewDecision } from "../review/review-types.js";
import { normalizePath, pushLine, pushWrappedLine } from "../lib/utils.js";
import { buildReviewBodyLines, type DiffViewMode } from "./review-diff-render.js";

function countReviewDiffStats(review: ReviewData): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;

  for (const change of review.changes) {
    if (change.diffModel) {
      additions += change.diffModel.additions;
      removals += change.diffModel.deletions;
      continue;
    }

    for (const line of change.lines) {
      if (line.kind === "add") additions++;
      if (line.kind === "remove") removals++;
    }
  }

  return { additions, removals };
}

function formatPlanList(items: string[], fallback: string): string {
  return items.length > 0 ? items.join(", ") : fallback;
}

function formatPlanLine(theme: ExtensionContext["ui"]["theme"], label: string, value: string, tone: "text" | "accent" | "warning" = "text"): string {
  return `${theme.bold(theme.fg("accent", `${label}:`))} ${theme.fg(tone, value)}`;
}

function getFileProgress(plannedFiles: string[], currentPath: string): { current: string; remaining: string[] } | undefined {
  const currentIndex = plannedFiles.indexOf(currentPath);
  if (currentIndex < 0) return undefined;

  return {
    current: `${currentIndex + 1}/${plannedFiles.length}`,
    remaining: plannedFiles.slice(currentIndex + 1),
  };
}

export async function handleReviewAction(
  ctx: ExtensionContext,
  review: ReviewData,
  diffViewMode: DiffViewMode = "split",
): Promise<ReviewDecision> {
  return ctx.ui.custom<ReviewDecision>(
    (tui, theme, _keybindings, done) => {
      const actions: ReviewAction[] = ["approve", "steer", "edit", "deny"];
      let selected = 0;
      let steeringMode = false;
      let steeringError: string | undefined;
      let focused = false;
      let previewScrollOffset = 0;
      let lastContentLineCount = 0;
      let lastVisibleContentRows = 1;
      const steeringInput = new Input();

      // Cached full review body — rebuilt only on mode/width change.
      let cachedBodyLines: string[] | null = null;
      let cachedWidth = 0;
      let cachedDiffViewMode: DiffViewMode = diffViewMode;

      const ensureBodyLines = (width: number) => {
        if (cachedBodyLines && cachedWidth === width && cachedDiffViewMode === diffViewMode) {
          return cachedBodyLines;
        }
        cachedBodyLines = buildReviewBodyLines(review, width, theme, diffViewMode);
        cachedWidth = width;
        cachedDiffViewMode = diffViewMode;
        return cachedBodyLines;
      };

      const invalidateBodyCache = () => {
        cachedBodyLines = null;
      };

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
        const planDivider = theme.fg("borderAccent", "─".repeat(Math.min(innerWidth, 72)));
        const diffStats = countReviewDiffStats(review);

        pushLine(headerLines, width, divider);
        pushWrappedLine(
          headerLines,
          width,
          `${theme.bold(theme.fg("toolTitle", `Review ${review.toolName}:`))} ${theme.bold(theme.fg("accent", review.path))}`,
        );
        if (review.plan) {
          const plannedFiles = review.plan.plannedFiles.map(normalizePath).filter(Boolean);
          const currentPath = normalizePath(review.path);
          const fileProgress = getFileProgress(plannedFiles, currentPath);
          pushLine(headerLines, width, planDivider);
          pushWrappedLine(headerLines, width, theme.bold(theme.fg("warning", "Plan preview")));
          if (review.plan.goal !== undefined) {
            pushWrappedLine(headerLines, width, formatPlanLine(theme, "Goal", review.plan.goal || "(not stated)", "accent"));
          }
          if (review.plan.currentStep !== undefined) {
            pushWrappedLine(headerLines, width, formatPlanLine(theme, "Now", review.plan.currentStep || "(not stated)", "accent"));
          }
          if (fileProgress) {
            pushWrappedLine(headerLines, width, formatPlanLine(theme, "File", fileProgress.current, "warning"));
            pushWrappedLine(headerLines, width, formatPlanLine(theme, "Files to review", formatPlanList(fileProgress.remaining, "(none)")));
          } else {
            pushWrappedLine(headerLines, width, formatPlanLine(theme, "Files to review", formatPlanList(plannedFiles, "(none listed)")));
          }
          if (plannedFiles.length > 0 && !plannedFiles.includes(currentPath)) {
            pushWrappedLine(headerLines, width, theme.bold(theme.fg("warning", `Plan warning: ${currentPath} is not listed in planned files.`)));
          }
          pushLine(headerLines, width, planDivider);
        } else {
          pushLine(headerLines, width, planDivider);
          pushWrappedLine(headerLines, width, theme.bold(theme.fg("warning", "Plan preview: no plan snapshot yet.")));
          pushWrappedLine(headerLines, width, theme.fg("text", "Ask the agent to update set_change_plan if the path is unclear."));
          pushLine(headerLines, width, planDivider);
        }
        pushWrappedLine(
          headerLines,
          width,
          `${theme.fg("dim", "Diff:")} ${theme.fg("success", `+${diffStats.additions}`)} ${theme.fg("dim", "/")} ${theme.fg("error", `-${diffStats.removals}`)}`,
        );
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
            invalidateBodyCache();
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
          const bodyLines = ensureBodyLines(width);
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
            const baseAvailableRows = Math.max(1, tui.terminal.rows - footerLines.length);
            const hasMoreBelow = previewScrollOffset + baseAvailableRows < contentLines.length;
            const availableRows = Math.max(1, baseAvailableRows - (hasMoreBelow ? 1 : 0));
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

          const baseAvailableRows = Math.max(1, tui.terminal.rows - footerLines.length);
          const shouldReserveMoreIndicator = previewScrollOffset + baseAvailableRows < contentLines.length;
          const availableRows = Math.max(1, baseAvailableRows - (shouldReserveMoreIndicator ? 1 : 0));
          lastContentLineCount = contentLines.length;
          lastVisibleContentRows = availableRows;
          clampPreviewScroll();

          const visibleContent = contentLines.slice(previewScrollOffset, previewScrollOffset + availableRows);
          const hasMoreBelow = previewScrollOffset + availableRows < contentLines.length;
          const moreIndicator = hasMoreBelow
            ? [theme.bold(theme.fg("warning", "↓ more below - scroll to continue"))]
            : [];
          return [...visibleContent, ...moreIndicator, ...footerLines];
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

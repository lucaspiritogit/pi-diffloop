import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, matchesKey } from "@mariozechner/pi-tui";
import type { ReviewAction, ReviewData, ReviewDecision } from "./review-types";
import { pushLine, pushWrappedLine } from "./utils";

export async function handleReviewAction(ctx: ExtensionContext, review: ReviewData): Promise<ReviewDecision> {
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
          const bodyLines = buildReviewBodyLines(review, width, theme);
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
            : "←/→ choose • ↑/↓ or j/k scroll • Enter confirm • Esc deny";

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
                ? `←/→ choose • ↑/↓ or j/k scroll • PgUp/PgDn page • Home/End jump (${visibleStart}-${visibleEnd}/${contentLines.length})`
                : "←/→ choose • Enter confirm • Esc deny";

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
    for (const line of change.lines) {
      const rendered =
        line.kind === "add"
          ? theme.fg("success", line.text)
          : line.kind === "remove"
            ? theme.fg("error", line.text)
            : line.kind === "warning"
              ? theme.fg("warning", line.text)
              : line.kind === "meta"
                ? theme.fg("accent", line.text)
                : theme.fg("dim", line.text);
      pushWrappedLine(lines, width, rendered);
    }
    lines.push("");
  }

  if (lines.length === 0) {
    pushWrappedLine(lines, width, theme.fg("dim", "No changes to preview."));
  }

  return lines;
}

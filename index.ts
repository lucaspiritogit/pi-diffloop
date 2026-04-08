import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
  type WriteToolInput,
} from "@mariozechner/pi-coding-agent";
import { Input, Key, matchesKey } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildUnifiedDiffPreview, type DiffPreviewLine } from "./diff-preview";
import { normalizePath, pushLine, pushWrappedLine } from "./utils";

export type ReviewAction = "approve" | "steer" | "edit" | "deny";
type ReviewDecision = Exclude<ReviewAction, "steer"> | { action: "steer"; steering: string };

type ReviewData = {
  toolName: "write" | "edit";
  path: string;
  reason: string;
  summary: string[];
  changes: Array<{ title: string; lines: DiffPreviewLine[] }>;
  editPreviewValidation?: {
    canApprove: boolean;
    errors: string[];
  };
};

const DIFFLOOP_REVIEW_STATUS = "diffloop";
const nativeEditTool = createEditToolDefinition(process.cwd());
const nativeWriteTool = createWriteToolDefinition(process.cwd());

type EditBlock = EditToolInput["edits"][number];
type EditInput = EditToolInput & { reason: string };
type WriteInput = WriteToolInput & { reason: string };

type NativeEditPreviewResult = { ok: true; diff?: string } | { ok: false; error: string; diff?: string };

type NativeEditBlockStatus = {
  index: number;
  ok: boolean;
  kind?: "notFound" | "notUnique" | "invalid";
  error?: string;
};

const EditParams = Type.Object(
  {
    ...nativeEditTool.parameters.properties,
    reason: Type.String({
      description: "In-depth explanation of why this exact file change is being proposed for human review",
    }),
  },
  { additionalProperties: false },
);

const WriteParams = Type.Object(
  {
    ...nativeWriteTool.parameters.properties,
    reason: Type.String({
      description: "In-depth explanation of why this file should be created or overwritten for human review",
    }),
  },
  { additionalProperties: false },
);

export function normalizeEditArguments(args: any) {
  if (!args || typeof args !== "object") return args;

  const input = args as {
    path?: string;
    reason?: string;
    edits?: Array<{ oldText?: unknown; newText?: unknown }>;
    oldText?: unknown;
    newText?: unknown;
  };

  const edits = Array.isArray(input.edits)
    ? input.edits.filter(
        (edit): edit is { oldText: string; newText: string } =>
          Boolean(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string",
      )
    : [];
  const { oldText, newText, ...rest } = input;

  if (typeof oldText === "string" && typeof newText === "string") {
    return {
      ...rest,
      edits: [...edits, { oldText, newText }],
    };
  }

  if (Array.isArray(input.edits) && edits.length !== input.edits.length) {
    return {
      ...rest,
      edits,
    };
  }

  return args;
}

export function normalizeWriteArguments(args: any) {
  if (!args || typeof args !== "object") return args;

  const input = args as { path?: string; content?: string; reason?: string };

  return {
    path: normalizePath(input.path || ""),
    content: typeof input.content === "string" ? input.content : "",
    reason: typeof input.reason === "string" ? input.reason.trim() : "",
  };
}

export default function reviewChanges(pi: ExtensionAPI) {
  let enabled = true;
  let pendingReadPath: string | undefined;

  pi.registerCommand("diffloop", {
    description: "Set diffloop on, off, toggle it, or show the current status",
    handler: async (args, ctx) => {
      const action = normalizeReviewModeAction(args);

      if (action === "invalid") {
        ctx.ui.notify("Usage: /diffloop [on|off|toggle|status]", "error");
        displayDiffloopStatus(ctx, enabled);
        return;
      }

      if (action === "toggle") enabled = !enabled;
      if (action === "on") enabled = true;
      if (action === "off") enabled = false;

      displayDiffloopStatus(ctx, enabled, true);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    displayDiffloopStatus(ctx, enabled);
  });

  pi.registerTool({
    ...nativeEditTool,
    description: [
      "Edit a single file using exact text replacement. Always include `reason`.",
      "Do not explain changes in generic prose.",
      "You must:",
      "- reference existing code patterns or nearby logic",
      "- describe exactly what this edit changes",
      "- describe behavior impact and preserved behavior when relevant",
      "- keep the rationale concrete, scoped, and file-specific",
    ].join("\n"),
    promptSnippet:
      "Use edit for precise file changes. Include a specific `reason` tied to the existing code pattern, the exact behavior being changed, and the expected impact.",
    promptGuidelines: [
      ...(nativeEditTool.promptGuidelines ?? []),
      "For every edit call, include a specific `reason` that explains what changes, why it is needed, and what behavior it affects.",
      "Do not use generic explanations; anchor the reason in the surrounding code, constraints, or preserved behavior.",
      "Keep edit blocks focused so the human reviewer can inspect and approve each change easily.",
    ],
    parameters: EditParams,
    prepareArguments: normalizeEditArguments,
    async execute(toolCallId, params, signal, onUpdate, toolCtx) {
      return nativeEditTool.execute(
        toolCallId,
        {
          path: normalizePath(params.path),
          edits: params.edits,
        },
        signal,
        onUpdate,
        toolCtx,
      );
    },
  });

  pi.registerTool({
    ...nativeWriteTool,
    description: [
      "Create or overwrite a file. Always include `reason`.",
      "Do not explain changes in generic prose.",
      "You must:",
      "- reference existing repository conventions, neighboring files, or code patterns when relevant",
      "- describe what the file contains or what is being replaced",
      "- describe behavior impact and intended usage",
      "- keep the rationale concrete, scoped, and file-specific",
    ].join("\n"),
    promptGuidelines: [
      ...(nativeWriteTool.promptGuidelines ?? []),
      "For every write call, include a specific `reason` that explains what the file is for, why it is needed, and what behavior it enables or changes.",
      "Do not use generic explanations; reference neighboring files, conventions, or usage expectations when relevant.",
      "Prefer concise, reviewable writes that the human can inspect and edit before execution.",
    ],
    parameters: WriteParams,
    prepareArguments: normalizeWriteArguments,
    async execute(toolCallId, params, signal, onUpdate, toolCtx) {
      return nativeWriteTool.execute(
        toolCallId,
        {
          path: normalizePath(params.path),
          content: params.content,
        },
        signal,
        onUpdate,
        toolCtx,
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "read")) {
      return undefined;
    }

    if (event.toolName === "read") {
      const readPath = typeof event.input.path === "string" ? normalizePath(event.input.path) : "";
      if (pendingReadPath && readPath === pendingReadPath) {
        pendingReadPath = undefined;
        if (ctx.hasUI) {
          ctx.ui.notify(`Read confirmed for ${readPath}. Agent may now choose edit/write.`, "info");
        }
      }
      return undefined;
    }

    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked ${event.toolName}: no interactive UI available for approval` };
    }

    while (true) {
      if (typeof event.input.path === "string") {
        event.input.path = normalizePath(event.input.path);
      }

      const input = event.input as WriteInput | EditInput;
      if (pendingReadPath) {
        return {
          block: true,
          reason: `Blocked ${event.toolName}: must read ${pendingReadPath} first, then decide whether to use edit or write.`,
        };
      }

      if (typeof input.reason !== "string" || !input.reason.trim()) {
        return {
          block: true,
          reason: `Blocked ${event.toolName}: missing required reason. Re-propose this ${event.toolName} with a concise explanation of what it changes and why.`,
        };
      }

      input.reason = input.reason.trim();

      const review = await buildReviewData(ctx, event.toolName, event.input as WriteInput | EditInput);
      const action = await handleReviewAction(ctx, review);

      if (action === "approve") {
        if (review.editPreviewValidation && !review.editPreviewValidation.canApprove) {
          pendingReadPath = review.path;
          pi.sendUserMessage(buildBlockedEditApprovalInstruction(review.path, input as EditInput, review), {
            deliverAs: "steer",
          });
          ctx.ui.notify(`Approval blocked for edit ${review.path}; automatic steering sent.`, "warning");
          return {
            block: true,
            reason: `Blocked edit approval for ${review.path}: preview validation failed and replanning was requested.`,
          };
        }

        ctx.ui.notify(`Approved ${event.toolName} ${review.path}`, "info");
        return undefined;
      }

      if (action === "deny") {
        return { block: true, reason: `Developer denied ${event.toolName} for ${review.path}` };
      }

      if (typeof action === "object" && action.action === "steer") {
        const message = buildSteeringInstruction(event.toolName, review.path, input, action.steering);
        if (!message) {
          ctx.ui.notify("Enter steering instructions to send feedback to the agent.", "warning");
          continue;
        }

        pendingReadPath = review.path;
        pi.sendUserMessage(message, { deliverAs: "steer" });
        ctx.ui.notify(`Steering sent for ${event.toolName} ${review.path}`, "warning");
        return { block: true, reason: `Developer steered ${event.toolName} for ${review.path}` };
      }

      const updated = await editProposal(ctx, event.toolName, event.input as WriteInput | EditInput);
      if (!updated) {
        ctx.ui.notify("Edit cancelled.", "info");
        continue;
      }

      pendingReadPath = review.path;
      pi.sendMessage(
        {
          customType: "diffloop-hidden-guidance",
          content: buildEditedProposalInstruction(event.toolName, review.path, updated),
          display: false,
        },
        { deliverAs: "steer" },
      );
      return { block: true, reason: `Developer edited ${event.toolName} for ${review.path} and requested replanning` };
    }
  });
}

async function buildReviewData(
  ctx: ExtensionContext,
  toolName: "write" | "edit",
  input: WriteInput | EditInput,
): Promise<ReviewData> {
  const path = normalizePath(input.path);
  const reason = input.reason.trim();
  const absolutePath = resolve(ctx.cwd, path);
  let existingContent: string | undefined;
  try {
    existingContent = await readFile(absolutePath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (toolName === "write") {
    const writeInput = input as WriteInput;
    const contentLines = writeInput.content.split("\n").length;
    const nativeWritePreview = await runNativeWritePreview(ctx.cwd, path, writeInput.content);

    const summary = [
      existingContent === undefined ? "Operation: create new file" : "Operation: overwrite existing file",
      `Size: ${writeInput.content.length} characters across ${contentLines} lines`,
    ];

    const warningLines = nativeWritePreview.ok
      ? []
      : [{ kind: "warning" as const, text: `! ${nativeWritePreview.error}` }];

    return {
      toolName,
      path,
      reason,
      summary,
      changes: [
        {
          title: existingContent === undefined ? "New file content preview" : "Replacement content preview",
          lines: [...warningLines, ...buildWriteContentPreview(writeInput.content)],
        },
      ],
    };
  }

  const editInput = normalizeEditInput(input as EditInput);
  const summary = [`Operation: ${editInput.edits.length} exact replacement block(s)`];

  if (existingContent === undefined) {
    const validationErrors = ["Target file was not found on disk."];
    return {
      toolName,
      path,
      reason,
      summary: [...summary, "Preview warning: target file does not exist on disk"],
      editPreviewValidation: {
        canApprove: false,
        errors: validationErrors,
      },
      changes: editInput.edits.map((edit, index) => ({
        title: `Edit block ${index + 1}`,
        lines: [
          { kind: "warning", text: "! Unable to compute file diff because the target file was not found." },
          ...buildUnifiedDiffPreview(edit.oldText, edit.newText, {
            beforeLabel: `block ${index + 1} before`,
            afterLabel: `block ${index + 1} after`,
            contextLines: 1,
          }).lines,
        ],
      })),
    };
  }

  const blockStatuses = await getNativeEditBlockStatuses(ctx.cwd, path, editInput.edits);
  const validBlocks = blockStatuses.filter((status) => status.ok).length;
  const invalidBlocks = blockStatuses.length - validBlocks;
  const preview = await runNativeEditPreview(ctx.cwd, path, editInput.edits);
  const warningLines = [
    ...blockStatuses.flatMap((status) => buildNativePreviewWarnings(status)),
    ...(!preview.ok ? [{ kind: "warning" as const, text: `! ${preview.error}` }] : []),
  ];
  const diff =
    preview.ok && typeof preview.diff === "string" ? buildPreviewFromNativeEditDiff(preview.diff) : undefined;

  summary.push(`Preview match: ${validBlocks}/${editInput.edits.length} block(s) accepted by Pi's native edit tool`);
  if (invalidBlocks) {
    summary.push(`Warnings: ${invalidBlocks} block(s) are missing or non-unique in the current file`);
  }
  if (!preview.ok) {
    summary.push(`Preview validation: ${preview.error}`);
  }

  const validationErrors = buildEditValidationErrors(blockStatuses, preview.ok ? undefined : preview.error);
  const canApprove = validationErrors.length === 0;
  if (!canApprove) {
    summary.push("Approval guard: invalid native preview; approve will trigger automatic read-first replanning");
  }

  if (diff) {
    if (diff.hasChanges) {
      summary.push(`Diff: +${diff.additions} / -${diff.removals} across ${Math.max(1, diff.hunks)} hunk(s)`);
    } else {
      summary.push("Diff: no textual changes");
    }
  }

  return {
    toolName,
    path,
    reason,
    summary,
    editPreviewValidation: {
      canApprove,
      errors: validationErrors,
    },
    changes: [
      {
        title: "Unified diff against current file",
        lines: [...warningLines, ...(diff?.lines ?? [])],
      },
    ],
  };
}

async function handleReviewAction(ctx: ExtensionContext, review: ReviewData): Promise<ReviewDecision> {
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

export function buildSteeringInstruction(
  toolName: "write" | "edit",
  path: string,
  input: WriteInput | EditInput,
  steering: string,
): string | undefined {
  const feedback = steering.trim();
  if (!feedback) return undefined;

  const normalizedPath = normalizePath(path);
  const currentReason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;
  return [
    `Do not execute the previously proposed ${toolName} for ${normalizedPath}.`,
    `Developer feedback to apply: ${feedback}`,
    currentReason ? `Previous rationale: ${currentReason}` : undefined,
    `First, read ${normalizedPath} to refresh current file state before deciding what to change.`,
    `After reading, choose the appropriate next step (edit or write) and continue only if a change is still needed.`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildBlockedEditApprovalInstruction(path: string, input: EditInput, review: ReviewData): string {
  const normalizedPath = normalizePath(path);
  const currentReason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;
  const validationErrors = review.editPreviewValidation?.errors ?? ["Native preview validation failed."];

  return [
    `Do not execute the previously proposed edit for ${normalizedPath}.`,
    "The proposal could not be approved because Pi's native edit preview reported validation failures.",
    ...validationErrors.map((error) => `Validation issue: ${error}`),
    currentReason ? `Previous rationale: ${currentReason}` : undefined,
    `First, read ${normalizedPath} to refresh current file state before deciding what to change.`,
    `Then propose a new edit with oldText copied exactly from ${normalizedPath}, including whitespace/newlines, and make each block unique with enough surrounding context.`,
    "If exact replacement remains unreliable, switch to write with the complete updated file content.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildEditedProposalInstruction(toolName: "write" | "edit", path: string, input: WriteInput | EditInput): string {
  const normalizedPath = normalizePath(path);
  const normalizedInput =
    toolName === "write"
      ? {
          path: normalizePath((input as WriteInput).path),
          reason: (input as WriteInput).reason.trim(),
          content: (input as WriteInput).content,
        }
      : normalizeEditInput(input as EditInput);

  return [
    `Do not execute the previously proposed ${toolName} for ${normalizedPath}.`,
    `The developer edited the proposal for ${normalizedPath}; use the updated intent below as guidance.`,
    JSON.stringify(normalizedInput, null, 2),
    `First, read ${normalizedPath} to refresh current file state.`,
    "After reading, decide whether edit or write is the right tool and continue only if a change is still required.",
  ].join("\n");
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

async function editProposal(
  ctx: ExtensionContext,
  toolName: "write" | "edit",
  input: WriteInput | EditInput,
): Promise<WriteInput | EditInput | undefined> {
  if (toolName === "write") {
    const writeInput = input as WriteInput;

    const content = await ctx.ui.editor(
      `Edit proposed content for ${normalizePath(writeInput.path)}`,
      writeInput.content,
    );
    if (content === undefined) return undefined;

    return {
      path: normalizePath(writeInput.path),
      reason: writeInput.reason.trim(),
      content,
    };
  }

  const current = normalizeEditInput(input as EditInput);

  if (current.edits.length === 1) {
    const edit = current.edits[0]!;
    const content = await ctx.ui.editor(`Edit proposed block for ${current.path}`, edit.newText);
    if (content === undefined) return undefined;

    return normalizeEditInput({
      path: current.path,
      reason: current.reason,
      edits: [{ oldText: edit.oldText, newText: content }],
    });
  }

  const absolutePath = resolve(ctx.cwd, current.path);
  let existingContent: string | undefined;
  try {
    existingContent = await readFile(absolutePath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const blockStatuses =
    existingContent !== undefined ? await getNativeEditBlockStatuses(ctx.cwd, current.path, current.edits) : undefined;
  const options = current.edits.map((edit, index) => describeEditBlockOption(edit, index, blockStatuses?.[index]));
  const choice = await ctx.ui.select(`Choose a proposed block to edit for ${current.path}`, options);
  if (choice === undefined) return undefined;

  const selectedIndex = options.indexOf(choice);
  if (selectedIndex < 0) return undefined;

  const selectedEdit = current.edits[selectedIndex]!;
  const content = await ctx.ui.editor(
    `Edit proposed block ${selectedIndex + 1} for ${current.path}`,
    selectedEdit.newText,
  );
  if (content === undefined) return undefined;

  return normalizeEditInput({
    path: current.path,
    reason: current.reason,
    edits: current.edits.map((edit, index) =>
      index === selectedIndex ? { oldText: edit.oldText, newText: content } : edit,
    ),
  });
}

async function runNativeEditPreview(cwd: string, path: string, edits: EditBlock[]): Promise<NativeEditPreviewResult> {
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
    const result = await nativeEdit.execute(
      "diffloop-native-preview",
      { path, edits },
      undefined,
      undefined,
      undefined as any,
    );
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

type NativeWritePreviewResult = { ok: true } | { ok: false; error: string };

async function runNativeWritePreview(cwd: string, path: string, content: string): Promise<NativeWritePreviewResult> {
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
    await nativeWrite.execute(
      "diffloop-native-write-preview",
      { path, content },
      undefined,
      undefined,
      undefined as any,
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildPreviewFromNativeEditDiff(diff: string) {
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

function buildWriteContentPreview(content: string, maxLines = 200): DiffPreviewLine[] {
  if (content.length === 0) {
    return [{ kind: "meta", text: "(empty file)" }];
  }

  const lines = content.split("\n");
  const previewLines: DiffPreviewLine[] = lines.slice(0, maxLines).map((line) => ({ kind: "add", text: `+${line}` }));

  if (lines.length > maxLines) {
    previewLines.push({ kind: "meta", text: `... (${lines.length - maxLines} more line(s) truncated)` });
  }

  return previewLines;
}

async function getNativeEditBlockStatuses(
  cwd: string,
  path: string,
  edits: EditBlock[],
): Promise<NativeEditBlockStatus[]> {
  return Promise.all(
    edits.map(async (edit, index) => {
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

function buildEditValidationErrors(blockStatuses: NativeEditBlockStatus[], previewError?: string): string[] {
  const notFound = blockStatuses.filter((status) => !status.ok && status.kind === "notFound").length;
  const notUnique = blockStatuses.filter((status) => !status.ok && status.kind === "notUnique").length;
  const invalid = blockStatuses.filter((status) => !status.ok && status.kind === "invalid").length;

  const errors: string[] = [];
  if (notFound > 0) {
    errors.push(`${notFound} block(s) did not match the current file content.`);
  }
  if (notUnique > 0) {
    errors.push(`${notUnique} block(s) matched multiple locations; oldText must be unique.`);
  }
  if (invalid > 0) {
    errors.push(`${invalid} block(s) were rejected by native preview validation.`);
  }
  if (previewError) {
    errors.push(previewError);
  }

  return errors;
}

function buildNativePreviewWarnings(status: NativeEditBlockStatus): DiffPreviewLine[] {
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

function describeEditBlockOption(edit: EditBlock, index: number, status?: NativeEditBlockStatus): string {
  const preview = summarizeCodeSnippet(edit.newText || edit.oldText);
  const suffix = !status
    ? ""
    : status.ok
      ? ""
      : status.kind === "notFound"
        ? " (not found)"
        : status.kind === "notUnique"
          ? " (not unique)"
          : " (invalid)";
  return `Block ${index + 1}${suffix}: ${preview}`;
}

function summarizeCodeSnippet(text: string, maxLength = 60): string {
  const singleLine = text.replace(/\s+/g, " ").trim() || "(empty)";
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}…`;
}

export function normalizeEditInput(input: EditInput): EditInput {
  const edits = Array.isArray(input.edits)
    ? input.edits
        .filter(
          (edit): edit is EditBlock =>
            Boolean(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string",
        )
        .map((edit) => ({ oldText: edit.oldText, newText: edit.newText }))
    : [];

  return {
    path: normalizePath(input.path),
    reason: input.reason?.trim() ?? "",
    edits,
  };
}

export function normalizeReviewModeAction(args?: string): "on" | "off" | "toggle" | "status" | "invalid" {
  const action = (args ?? "status").trim().toLowerCase();

  if (!action || action === "status") return "status";
  if (action === "on" || action === "enable" || action === "enabled") return "on";
  if (action === "off" || action === "disable" || action === "disabled") return "off";
  if (action === "toggle") return "toggle";
  return "invalid";
}

function displayDiffloopStatus(ctx: ExtensionContext, enabled: boolean, announce = false) {
  if (!ctx.hasUI) return;

  const statusText = enabled ? ctx.ui.theme.fg("warning", "diffloop on") : ctx.ui.theme.fg("dim", "diffloop off");
  ctx.ui.setStatus(DIFFLOOP_REVIEW_STATUS, statusText);
  if (announce) {
    ctx.ui.notify(`Diffloop ${enabled ? "on" : "off"}`, enabled ? "warning" : "info");
  }
}

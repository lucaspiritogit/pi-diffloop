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
import { normalizePath, replaceObject, pushLine, pushWrappedLine } from "./utils";

export type ReviewAction = "approve" | "steer" | "edit" | "deny";
type ReviewDecision = Exclude<ReviewAction, "steer"> | { action: "steer"; steering: string };

type ReviewData = {
  toolName: "write" | "edit";
  path: string;
  reason: string;
  summary: string[];
  changes: Array<{ title: string; lines: DiffPreviewLine[] }>;
};

const DIFFLOOP_REVIEW_STATUS = "diffloop";
const nativeEditTool = createEditToolDefinition(process.cwd());
const nativeWriteTool = createWriteToolDefinition(process.cwd());

type EditBlock = EditToolInput["edits"][number];
type EditInput = EditToolInput & { reason: string };
type WriteInput = WriteToolInput & { reason: string };

const EditParams = Type.Object(
  {
    ...nativeEditTool.parameters.properties,
    reason: Type.String({
      description: "One or two sentences explaining why this exact file change is being proposed for human review",
    }),
  },
  { additionalProperties: false },
);

const WriteParams = Type.Object(
  {
    ...nativeWriteTool.parameters.properties,
    reason: Type.String({
      description: "One or two sentences explaining why this file should be created or overwritten for human review",
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
    promptSnippet:
      "Use write for new files or full rewrites. Include a specific `reason` tied to repository patterns, the file's role, and the expected behavior impact.",
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
    if (!enabled || (event.toolName !== "edit" && event.toolName !== "write")) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked ${event.toolName}: no interactive UI available for approval` };
    }

    while (true) {
      if (typeof event.input.path === "string") {
        event.input.path = normalizePath(event.input.path);
      }

      const input = event.input as WriteInput | EditInput;
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

        if (ctx.isIdle()) {
          pi.sendUserMessage(message);
        } else {
          pi.sendUserMessage(message, { deliverAs: "steer" });
        }
        ctx.ui.notify(`Steering sent for ${event.toolName} ${review.path}`, "warning");
        return { block: true, reason: `Developer steered ${event.toolName} for ${review.path}` };
      }

      const updated = await editProposal(ctx, event.toolName, event.input as WriteInput | EditInput);
      if (!updated) {
				ctx.ui.notify("Edit cancelled.", "info");
				continue;
      }
      replaceObject(event.input as Record<string, unknown>, updated as Record<string, unknown>);
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
    const diff = buildUnifiedDiffPreview(existingContent ?? "", writeInput.content, {
      beforeLabel: existingContent === undefined ? "/dev/null" : `${path} (current)`,
      afterLabel: path,
      contextLines: 3,
    });
    const summary = [
      existingContent === undefined ? "Operation: create new file" : "Operation: overwrite existing file",
      `Size: ${writeInput.content.length} characters across ${contentLines} lines`,
      diff.hasChanges
        ? `Diff: +${diff.additions} / -${diff.removals} across ${Math.max(1, diff.hunks)} hunk(s)`
        : "Diff: no textual changes",
    ];

    return {
      toolName,
      path,
      reason,
      summary,
      changes: [
        {
          title: existingContent === undefined ? "New file diff" : "Unified diff against current file",
          lines: diff.lines,
        },
      ],
    };
  }

  const editInput = normalizeEditInput(input as EditInput);
  const summary = [`Operation: ${editInput.edits.length} exact replacement block(s)`];

  if (existingContent === undefined) {
    return {
      toolName,
      path,
      reason,
      summary: [...summary, "Preview warning: target file does not exist on disk"],
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
    preview.ok && preview.originalContent !== undefined && preview.nextContent !== undefined
      ? buildUnifiedDiffPreview(preview.originalContent, preview.nextContent, {
          beforeLabel: `${path} (current)`,
          afterLabel: path,
          contextLines: 3,
        })
      : undefined;

  summary.push(`Preview match: ${validBlocks}/${editInput.edits.length} block(s) accepted by Pi's native edit tool`);
  if (invalidBlocks) {
    summary.push(`Warnings: ${invalidBlocks} block(s) are missing or non-unique in the current file`);
  }
  if (!preview.ok) {
    summary.push(`Preview validation: ${preview.error}`);
  }
  if (diff) {
    if (diff.hasChanges) {
      summary.push(`Diff: +${diff.additions} / -${diff.removals} across ${Math.max(1, diff.hunks)} hunk(s)`);
    } else {
      summary.push("Diff: no textual changes");
    }
  } else {
    summary.push("Diff: unavailable because Pi rejected the edit proposal during preview validation");
  }

  return {
    toolName,
    path,
    reason,
    summary,
    changes: [
      {
        title: "Unified diff against current file",
        lines: [...warningLines, ...(diff?.lines ?? [])],
      },
    ],
  };
}

async function handleReviewAction(ctx: ExtensionContext, review: ReviewData): Promise<ReviewDecision> {
  return ctx.ui.custom<ReviewDecision>((tui, theme, _keybindings, done) => {
    const actions: ReviewAction[] = ["approve", "steer", "edit", "deny"];
    let selected = 0;
    let steeringMode = false;
    let steeringError: string | undefined;
    let focused = false;
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
      const reasonLines: string[] = [];
      const maxReasonLines = Math.max(2, Math.min(4, tui.terminal.rows - 8));

      pushLine(headerLines, width, divider);
      pushWrappedLine(headerLines, width, theme.fg("dim", theme.bold(`Review ${review.toolName}: ${review.path}`)));
      pushWrappedLine(reasonLines, width, theme.fg("accent", `Why: ${review.reason}`));
      headerLines.push(...reasonLines.slice(0, maxReasonLines));
      if (reasonLines.length > maxReasonLines && headerLines.length > 0) {
        headerLines[headerLines.length - 1] += theme.fg("dim", " …");
      }
      headerLines.push("");

      return { headerLines, divider, reasonTruncated: reasonLines.length > maxReasonLines };
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
        const { headerLines, divider, reasonTruncated } = buildHeaderLines(width);
        const bodyLines = buildReviewBodyLines(review, width, theme);
        const footerLines: string[] = [];

        pushLine(
          footerLines,
          width,
          `${actionLabel("approve")} ${actionLabel("steer")}  ${actionLabel("edit")}  ${actionLabel("deny")}`,
        );
        pushWrappedLine(
          footerLines,
          width,
          theme.fg(
            "dim",
            steeringMode
              ? "Type steering feedback below • Enter send • Esc cancel • use terminal scroll to review the diff"
              : "←/→ choose • Enter confirm • Esc deny • use terminal scroll to review the diff",
          ),
        );
        if (reasonTruncated) {
          pushWrappedLine(footerLines, width, theme.fg("dim", "Reason shortened to keep it visible."));
        }
        if (steeringMode) {
          footerLines.push("");
          pushWrappedLine(footerLines, width, theme.fg("warning", theme.bold("Steering feedback")));
          pushWrappedLine(
            footerLines,
            width,
            theme.fg("dim", "Describe what should change, what should stay the same, and any behavior constraints."),
          );
          footerLines.push(...steeringInput.render(width));
          if (steeringError) {
            pushWrappedLine(footerLines, width, theme.fg("warning", steeringError));
          }
        }
        pushLine(footerLines, width, divider);

        return [...headerLines, ...bodyLines, ...footerLines];
      },
    };
  });
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
    `Revise the ${toolName} proposal for ${normalizedPath} based on this developer feedback: ${feedback}`,
    currentReason ? `Previous rationale: ${currentReason}` : undefined,
    "Respond by proposing an updated tool call with a concise reason before making changes again.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
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
  const blockStatuses = existingContent !== undefined ? await getNativeEditBlockStatuses(ctx.cwd, current.path, current.edits) : undefined;
  const options = current.edits.map((edit, index) => describeEditBlockOption(edit, index, blockStatuses?.[index]));
  const choice = await ctx.ui.select(`Choose a proposed block to edit for ${current.path}`, options);
  if (choice === undefined) return undefined;

  const selectedIndex = options.indexOf(choice);
  if (selectedIndex < 0) return undefined;

  const selectedEdit = current.edits[selectedIndex]!;
  const content = await ctx.ui.editor(`Edit proposed block ${selectedIndex + 1} for ${current.path}`, selectedEdit.newText);
  if (content === undefined) return undefined;

  return normalizeEditInput({
    path: current.path,
    reason: current.reason,
    edits: current.edits.map((edit, index) =>
      index === selectedIndex ? { oldText: edit.oldText, newText: content } : edit,
    ),
  });
}

type NativeEditPreviewResult =
  | { ok: true; originalContent?: string; nextContent?: string }
  | { ok: false; error: string; originalContent?: string; nextContent?: string };

type NativeEditBlockStatus = {
  index: number;
  ok: boolean;
  kind?: "notFound" | "notUnique" | "invalid";
  error?: string;
};

async function runNativeEditPreview(cwd: string, path: string, edits: EditBlock[]): Promise<NativeEditPreviewResult> {
  let originalBuffer: Buffer | undefined;
  let nextContent: string | undefined;

  const nativeEdit = createEditToolDefinition(cwd, {
    operations: {
      async access(absolutePath: string) {
        await access(absolutePath, constants.R_OK | constants.W_OK);
      },
      async readFile(absolutePath: string) {
        const buffer = await readFile(absolutePath);
        originalBuffer = buffer;
        return buffer;
      },
      async writeFile(_absolutePath: string, content: string) {
        nextContent = content;
      },
    },
  });

  try {
    await nativeEdit.execute("diffloop-native-preview", { path, edits }, undefined, undefined, undefined as any);
    return {
      ok: true,
      originalContent: originalBuffer?.toString("utf8"),
      nextContent,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      originalContent: originalBuffer?.toString("utf8"),
      nextContent,
    };
  }
}

async function getNativeEditBlockStatuses(cwd: string, path: string, edits: EditBlock[]): Promise<NativeEditBlockStatus[]> {
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

function buildNativePreviewWarnings(status: NativeEditBlockStatus): DiffPreviewLine[] {
  if (status.ok) return [];
  if (status.kind === "notFound") {
    return [
      {
        kind: "warning",
        text: `! Edit block ${status.index + 1} oldText was not found by Pi's native edit tool and will fail at execution time.`,
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
      text: `! Edit block ${status.index + 1} could not be validated by Pi's native edit tool: ${status.error}`,
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


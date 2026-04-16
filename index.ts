import {
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import {
  applyEditBlocksToContent,
  buildEditValidationErrors,
  buildNativePreviewWarnings,
  buildPreviewFromNativeEditDiff,
  buildWriteContentPreview,
  getNativeEditBlockStatuses,
  runNativeEditPreview,
  runNativeWritePreview,
} from "./diff-preview";
import { loadDiffloopConfig, saveEnabledToConfig } from "./review-scope";
import type { EditBlock, EditInput, NativeEditBlockStatus, ReviewData, WriteInput } from "./review-types";
import { appendDiffloopAudit, readDiffloopAuditStats } from "./diffloop-audit";
import { handleReviewToolCall } from "./review-pipeline";
import { createDiffloopRuntimeState } from "./runtime-state";
import { buildStructuredDiff } from "./structured-diff";
import { normalizePath } from "./utils";
import { getCachedDiffloopUpdateVersion } from "./version-status";

export { buildReviewBodyLines } from "./review-ui";
export { buildSteeringInstruction } from "./tool-hooks";

const DIFFLOOP_REVIEW_STATUS = "diffloop";
const DIFFLOOP_REASON_TOOL_NAME = "set_change_reason";
const DIFFLOOP_REASON_GUIDANCE =
  `Before every edit/write tool call, call ${DIFFLOOP_REASON_TOOL_NAME} first with one concrete reason tied to repository context and behavior impact.`;

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

function normalizeReasonValue(reason: unknown): string {
  return typeof reason === "string" ? reason.trim() : "";
}

function buildReviewedMutationInstruction(toolName: "write" | "edit", path: string): string {
  const normalizedPath = normalizePath(path) || "(unknown path)";
  return [
    `Diffloop applied the developer-reviewed ${toolName} proposal for ${normalizedPath}.`,
    "Treat the current on-disk file content as the source of truth and do not reapply the previous draft.",
  ].join(" ");
}

export default function reviewChanges(pi: ExtensionAPI) {
  const state = createDiffloopRuntimeState(loadDiffloopConfig());
  let availableUpdateVersion: string | undefined;
  let auditStatsSuffix = "";

  const sendSteeringFeedback = (message: string): boolean => {
    try {
      pi.sendUserMessage(message, { deliverAs: "steer" });
      return true;
    } catch {
      return false;
    }
  };

  const refreshAuditStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      auditStatsSuffix = "";
      return;
    }
    if (typeof (ctx as any).sessionManager?.getBranch !== "function") {
      auditStatsSuffix = "";
      return;
    }
    const stats = readDiffloopAuditStats(ctx);
    if (stats.decisions === 0 && stats.blocked === 0 && stats.recoveries === 0) {
      auditStatsSuffix = "";
      return;
    }
    auditStatsSuffix = ` ${ctx.ui.theme.fg("dim", `d${stats.decisions} b${stats.blocked} r${stats.recoveries}`)}`;
  };

  const blockWithReason = (
    reason: string,
    _key?: string,
    meta?: { code: string; toolName?: "write" | "edit"; path?: string },
  ) => {
    const blocked = state.buildBlockedResult(reason);
    if (blocked.reason) {
      appendDiffloopAudit(pi, {
        kind: "blocked",
        code: meta?.code ?? "blocked",
        toolName: meta?.toolName,
        path: meta?.path,
        reason: blocked.reason,
      });
    }
    return blocked;
  };

  const syncReasonToolActivation = () => {
    const api = pi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
    if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;

    const activeTools = api.getActiveTools();
    const withoutReasonTool = activeTools.filter((toolName) => toolName !== DIFFLOOP_REASON_TOOL_NAME);

    if (state.getEnabled()) {
      if (!activeTools.includes(DIFFLOOP_REASON_TOOL_NAME)) {
        api.setActiveTools([...withoutReasonTool, DIFFLOOP_REASON_TOOL_NAME]);
      }
      return;
    }

    if (withoutReasonTool.length !== activeTools.length) {
      api.setActiveTools(withoutReasonTool);
    }
  };

  pi.registerCommand("diffloop", {
    description: "Set diffloop on, off, toggle it, or show the current status",
    handler: async (args, ctx) => {
      const action = normalizeReviewModeAction(args);
      const enabled = state.getEnabled();

      if (action === "invalid") {
        ctx.ui.notify("Usage: /diffloop [on|off|toggle|status]", "error");
        displayDiffloopStatus(ctx, enabled, false, availableUpdateVersion, auditStatsSuffix);
        return;
      }

      const wasEnabled = enabled;
      let nextEnabled = enabled;
      if (action === "toggle") nextEnabled = !enabled;
      if (action === "on") nextEnabled = true;
      if (action === "off") nextEnabled = false;
      state.setEnabled(nextEnabled);

      if (action !== "status") {
        try {
          saveEnabledToConfig(nextEnabled);
          appendDiffloopAudit(pi, { kind: "toggle", enabled: nextEnabled });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to persist diffloop state: ${message}`, "warning");
        }
      }

      if (wasEnabled && !nextEnabled) {
        state.setDenyHold(false);
        state.clearPendingChangeReasons();
        state.clearReadRequirements();
      }

      syncReasonToolActivation();
      refreshAuditStatus(ctx);
      displayDiffloopStatus(ctx, nextEnabled, true, availableUpdateVersion, auditStatsSuffix);
    },
  });

  pi.registerTool?.({
    name: DIFFLOOP_REASON_TOOL_NAME,
    label: DIFFLOOP_REASON_TOOL_NAME,
    description: "Record the reason for the next edit/write proposal.",
    promptSnippet: "Record reason before each edit/write",
    promptGuidelines: [
      `Before each edit/write call, use ${DIFFLOOP_REASON_TOOL_NAME} with one concrete reason tied to current code.`,
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Concrete reason for the next file mutation." }),
    }),
    async execute(_toolCallId, params: { reason: string }) {
      return {
        content: [{ type: "text" as const, text: `Reason recorded: ${params.reason.trim()}` }],
        details: undefined,
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.getEnabled()) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${DIFFLOOP_REASON_GUIDANCE}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    state.refreshConfig(loadDiffloopConfig());
    state.resetForSessionBoundary();
    syncReasonToolActivation();
    refreshAuditStatus(ctx);
    displayDiffloopStatus(ctx, state.getEnabled(), false, availableUpdateVersion, auditStatsSuffix);

    void (async () => {
      availableUpdateVersion = await getCachedDiffloopUpdateVersion();
      if (availableUpdateVersion) {
        displayDiffloopStatus(ctx, state.getEnabled(), false, availableUpdateVersion, auditStatsSuffix);
      }
    })();
  });

  pi.on("session_tree", async (_event, ctx) => {
    state.resetForSessionBoundary();
    refreshAuditStatus(ctx);
    displayDiffloopStatus(ctx, state.getEnabled(), false, availableUpdateVersion, auditStatsSuffix);
  });

  pi.on("session_shutdown", async () => {
    state.resetForSessionBoundary();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      state.clearPendingChangeReasons();
    }

    if (!state.getDenyHold()) return;
    if (event.source === "extension") return;

    state.setDenyHold(false);
    state.clearReadRequirements();
    if (ctx.hasUI) {
      ctx.ui.notify("Deny lock cleared. Reviewing can continue on the new prompt.", "info");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    return handleReviewToolCall(event, ctx, {
      state,
      reasonToolName: DIFFLOOP_REASON_TOOL_NAME,
      normalizeReasonValue,
      normalizeToolCallInput,
      sanitizeToolCallInput,
      buildReviewData,
      editProposal,
      sendSteeringFeedback,
      blockWithReason,
      onDecision: (decision) => {
        appendDiffloopAudit(pi, {
          kind: "decision",
          action: decision.action,
          toolName: decision.toolName,
          path: decision.path,
          reason: decision.reason,
        });
      },
      onDenyAbort: (pipelineCtx) => {
        pipelineCtx.abort();
      },
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    const inputPath = typeof event.input?.path === "string" ? event.input.path : undefined;
    const pendingReviewedMutation =
      event.toolName === "write" || event.toolName === "edit"
        ? state.consumePendingReviewedMutation(event.toolName, event.toolCallId, inputPath)
        : undefined;

    if (isWriteToolResult(event)) {
      const pendingWriteOverride = state.consumePendingWriteOverride(event.toolCallId, inputPath);
      if (pendingWriteOverride && !event.isError) {
        const normalizedOverridePath = normalizePath(pendingWriteOverride.path || inputPath || "");
        const absolutePath = resolve(ctx.cwd, normalizedOverridePath);
        try {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, pendingWriteOverride.content, "utf8");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Failed to apply reviewed write override for ${normalizedOverridePath}: ${message}`,
              "warning",
            );
          }
          return {
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: `Diffloop warning: failed to apply reviewed write override for ${normalizedOverridePath}: ${message}`,
              },
            ],
            details: event.details,
          };
        }

      }
    }

    const isEditOrWriteError = (event.toolName === "edit" || event.toolName === "write") && event.isError;
    if (isEditOrWriteError) {
      const failedPath = typeof event.input?.path === "string" ? normalizePath(event.input.path) : "";
      if (!failedPath) return undefined;

      state.setPendingReadRequirements(failedPath);
      appendDiffloopAudit(pi, {
        kind: "recovery",
        toolName: event.toolName === "edit" ? "edit" : "write",
        path: failedPath,
        isError: true,
      });

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Detected ${event.toolName} execution error on ${failedPath}; enforcing read-first retry before the next edit/write.`,
          "warning",
        );
      }

      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `Diffloop recovery: read ${failedPath} and then submit one revised ${event.toolName} proposal.`,
          },
        ],
      };
    }

    if (!event.isError && pendingReviewedMutation) {
      const reviewedMutationInstruction = buildReviewedMutationInstruction(
        pendingReviewedMutation.toolName,
        pendingReviewedMutation.path || inputPath || "",
      );
      sendSteeringFeedback(reviewedMutationInstruction);
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: reviewedMutationInstruction,
          },
        ],
        details: event.details,
      };
    }
    return undefined;
  });
}

async function buildReviewData(
  ctx: ExtensionContext,
  toolName: "write" | "edit",
  input: WriteInput | EditInput,
): Promise<ReviewData> {
  const path = normalizePath(input.path);
  const reason = input.reason.trim() || "(no reason provided)";
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
    const diffModel = buildStructuredDiff(existingContent ?? "", writeInput.content);

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
          diffModel,
        },
      ],
    };
  }

  const editInput = normalizeEditInput(input as EditInput);
  const summary = [`Operation: ${editInput.edits.length} exact replacement block(s)`];

  if (existingContent === undefined) {
    const validationErrors = ["Target file was not found on disk."];
    const candidatePreview = buildMissingTargetPreview(editInput);
    return {
      toolName,
      path,
      reason,
      summary: [
        ...summary,
        "Preview warning: target file does not exist on disk",
        "Fallback preview: generated from proposed edit newText blocks",
      ],
      editPreviewValidation: {
        canApprove: false,
        errors: validationErrors,
        missingTarget: true,
      },
      changes: [
        {
          title: "Candidate content preview (target file missing)",
          lines: [
            { kind: "warning", text: "! Unable to compute file diff because the target file was not found." },
            { kind: "warning", text: "! Approval is blocked for edit on missing files; submit a write proposal instead." },
            ...buildWriteContentPreview(candidatePreview),
          ],
          diffModel: buildStructuredDiff("", candidatePreview),
        },
      ],
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
  const appliedEditResult = applyEditBlocksToContent(existingContent, editInput.edits);
  const diffModel = appliedEditResult.ok ? buildStructuredDiff(existingContent, appliedEditResult.afterText) : undefined;

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
        diffModel,
      },
    ],
  };
}

function buildMissingTargetPreview(input: EditInput): string {
  const normalized = normalizeEditInput(input);
  if (normalized.edits.length === 0) return "";
  return normalized.edits.map((edit) => edit.newText).join("\n");
}



async function editProposal(
  ctx: ExtensionContext,
  toolName: "write" | "edit",
  input: WriteInput | EditInput,
): Promise<WriteInput | EditInput | undefined> {
  if (toolName === "write") {
    const writeInput = input as WriteInput;

    const content = await openProposalInEditor(
      ctx,
      normalizePath(writeInput.path),
      writeInput.content,
      `Edit proposed content for ${normalizePath(writeInput.path)}`,
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
    const content = await openProposalInEditor(ctx, current.path, edit.newText, `Edit proposed block for ${current.path}`);
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
  const content = await openProposalInEditor(
    ctx,
    current.path,
    selectedEdit.newText,
    `Edit proposed block ${selectedIndex + 1} for ${current.path}`,
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

type ExternalEditorResult = {
  exitCode: number;
  errorMessage?: string;
};

async function openProposalInEditor(
  ctx: ExtensionContext,
  path: string,
  initialContent: string,
  fallbackTitle: string,
): Promise<string | undefined> {
  const editorCmd = process.env.EDITOR || process.env.VISUAL;
  if (!editorCmd) {
    return ctx.ui.editor(fallbackTitle, initialContent);
  }

  const fileExtension = extname(path) || ".txt";
  const tempDir = await mkdtemp(join(tmpdir(), "diffloop-editor-"));
  const draftPath = join(tempDir, `proposal${fileExtension}`);

  try {
    try {
      await chmod(tempDir, 0o700);
    } catch {
    }

    await writeFile(draftPath, initialContent, { encoding: "utf8", mode: 0o600 });

    const shell = process.env.SHELL || "/bin/sh";
    const escapedPath = draftPath.replace(/(["\\`$])/g, "\\$1");
    const command = `${editorCmd} "${escapedPath}"`;

    const result = await ctx.ui.custom<ExternalEditorResult>(
      (tui, _theme, _kb, done) => {
        tui.stop();
        process.stdout.write("\x1b[2J\x1b[H");

        try {
          const run = spawnSync(shell, ["-c", command], {
            stdio: "inherit",
            env: process.env,
          });

          done({
            exitCode: run.status ?? 1,
            errorMessage: run.error instanceof Error ? run.error.message : undefined,
          });
        } catch (error) {
          done({
            exitCode: 1,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        } finally {
          tui.start();
          tui.requestRender(true);
        }

        return { render: () => [], invalidate: () => {} };
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

    if (result.exitCode !== 0) {
      ctx.ui.notify(
        result.errorMessage
          ? `External editor failed: ${result.errorMessage}`
          : `External editor exited with code ${result.exitCode}.`,
        "warning",
      );
      return undefined;
    }

    return (await readFile(draftPath, "utf8")).replace(/\n$/, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

function summarizeCodeSnippet(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim() || "(empty)";
  return singleLine;
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

function normalizeWriteInput(input: unknown): WriteInput {
  const raw = (input && typeof input === "object" ? input : {}) as {
    path?: unknown;
    content?: unknown;
    reason?: unknown;
  };

  return {
    path: normalizePath(typeof raw.path === "string" ? raw.path : ""),
    content: typeof raw.content === "string" ? raw.content : "",
    reason: typeof raw.reason === "string" ? raw.reason.trim() : "",
  };
}

function normalizeToolCallInput(toolName: "write" | "edit", input: unknown): WriteInput | EditInput {
  if (toolName === "write") {
    return normalizeWriteInput(input);
  }

  const normalizedEditArgs = normalizeEditArguments(input as any);
  const raw = (normalizedEditArgs && typeof normalizedEditArgs === "object" ? normalizedEditArgs : {}) as EditInput;
  return normalizeEditInput(raw);
}

function sanitizeToolCallInput(
  event: { input: unknown },
  toolName: "write" | "edit",
  normalizedInput: WriteInput | EditInput,
) {
  if (toolName === "write") {
    event.input = {
      path: normalizedInput.path,
      content: (normalizedInput as WriteInput).content,
    };
    return;
  }

  event.input = {
    path: normalizedInput.path,
    edits: (normalizedInput as EditInput).edits,
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

function displayDiffloopStatus(
  ctx: ExtensionContext,
  enabled: boolean,
  announce = false,
  availableUpdateVersion?: string,
  auditStatsSuffix = "",
) {
  if (!ctx.hasUI) return;

  const baseStatusText = enabled ? ctx.ui.theme.fg("warning", "diffloop on") : ctx.ui.theme.fg("dim", "diffloop off");
  const updateStatusText = availableUpdateVersion
    ? ctx.ui.theme.fg("accent", ` update v${availableUpdateVersion} available`)
    : "";

  ctx.ui.setStatus(DIFFLOOP_REVIEW_STATUS, `${baseStatusText}${updateStatusText}${auditStatsSuffix}`);
  if (announce) {
    ctx.ui.notify(`Diffloop ${enabled ? "on" : "off"}`, enabled ? "warning" : "info");
  }
}

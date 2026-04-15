import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import {
  buildEditedProposalCandidate,
  clearStaleCandidateDirectories,
  createCandidateFilesSessionManager,
  persistEditedProposal,
  registerCandidateFilesProcessCleanup,
} from "./candidate-files";
import {
  buildEditValidationErrors,
  buildNativePreviewWarnings,
  buildPreviewFromNativeEditDiff,
  buildWriteContentPreview,
  getNativeEditBlockStatuses,
  runNativeEditPreview,
  runNativeWritePreview,
} from "./diff-preview";
import { handleReviewAction } from "./review-ui";
import { createReviewScopeFromEnv, isPathInReviewScope } from "./review-scope";
import type { EditBlock, EditInput, NativeEditBlockStatus, ReviewData, WriteInput } from "./review-types";
import {
  buildBlockedEditApprovalInstruction,
  buildEditedProposalInstruction,
  buildMissingTargetEditInstruction,
  buildSteeringInstruction,
  joinPathList,
} from "./tool-hooks";
import { normalizePath, pathExists } from "./utils";
import { getCachedDiffloopUpdateVersion } from "./version-status";

export { clearCandidateFilesDirectory } from "./candidate-files";
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

export default function reviewChanges(pi: ExtensionAPI) {
  registerCandidateFilesProcessCleanup();
  void clearStaleCandidateDirectories();

  let enabled = true;
  const reviewScope = createReviewScopeFromEnv();
  const pendingReadPaths = new Set<string>();
  let pendingEditedProposalPath: string | undefined;
  let pendingEditedProposalReadToolCallId: string | undefined;
  let denyHold = false;
  const candidateFiles = createCandidateFilesSessionManager();
  let availableUpdateVersion: string | undefined;

  const clearPendingEditedProposal = async () => {
    pendingEditedProposalPath = undefined;
    pendingEditedProposalReadToolCallId = undefined;
    await candidateFiles.clearSessionDirectory();
  };

  const clearReadRequirements = async () => {
    pendingReadPaths.clear();
    await clearPendingEditedProposal();
  };

  const setPendingReadRequirements = (...paths: Array<string | undefined>) => {
    pendingReadPaths.clear();
    for (const path of paths) {
      if (!path) continue;
      pendingReadPaths.add(path);
    }
  };

  const pendingChangeReasons: string[] = [];

  const clearPendingChangeReasons = () => {
    pendingChangeReasons.length = 0;
  };

  const queuePendingChangeReason = (reason: unknown): boolean => {
    const normalizedReason = normalizeReasonValue(reason);
    if (!normalizedReason) return false;

    pendingChangeReasons.push(normalizedReason);
    return true;
  };

  const consumePendingChangeReason = (): string | undefined => {
    while (pendingChangeReasons.length > 0) {
      const reason = normalizeReasonValue(pendingChangeReasons.shift());
      if (reason) return reason;
    }

    return undefined;
  };

  pi.registerCommand("diffloop", {
    description: "Set diffloop on, off, toggle it, or show the current status",
    handler: async (args, ctx) => {
      const action = normalizeReviewModeAction(args);

      if (action === "invalid") {
        ctx.ui.notify("Usage: /diffloop [on|off|toggle|status]", "error");
        displayDiffloopStatus(ctx, enabled, false, availableUpdateVersion);
        return;
      }

      if (action === "toggle") enabled = !enabled;
      if (action === "on") enabled = true;
      if (action === "off") enabled = false;

      displayDiffloopStatus(ctx, enabled, true, availableUpdateVersion);
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
    if (!enabled) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${DIFFLOOP_REASON_GUIDANCE}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    clearPendingChangeReasons();
    await candidateFiles.clearSessionDirectory();
    candidateFiles.setSessionFromContext(ctx);
    await clearStaleCandidateDirectories();
    displayDiffloopStatus(ctx, enabled, false, availableUpdateVersion);

    void (async () => {
      availableUpdateVersion = await getCachedDiffloopUpdateVersion();
      if (availableUpdateVersion) {
        displayDiffloopStatus(ctx, enabled, false, availableUpdateVersion);
      }
    })();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      clearPendingChangeReasons();
    }

    if (!denyHold) return;
    if (event.source === "extension") return;

    denyHold = false;
    await clearReadRequirements();
    if (ctx.hasUI) {
      ctx.ui.notify("Deny lock cleared. Reviewing can continue on the new prompt.", "info");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      !enabled ||
      (event.toolName !== "edit" &&
        event.toolName !== "write" &&
        event.toolName !== "read" &&
        event.toolName !== DIFFLOOP_REASON_TOOL_NAME)
    ) {
      return undefined;
    }

    if (event.toolName === DIFFLOOP_REASON_TOOL_NAME) {
      const reason = normalizeReasonValue((event.input as { reason?: unknown } | undefined)?.reason);
      if (!reason) {
        return {
          block: true,
          reason: `Blocked ${DIFFLOOP_REASON_TOOL_NAME}: include a non-empty reason and retry.`,
        };
      }

      queuePendingChangeReason(reason);
      event.input = { reason };
      return undefined;
    }

    if (event.toolName === "read") {
      if (pendingReadPaths.size === 0) return undefined;

      const normalizedReadPath = typeof event.input.path === "string" ? normalizePath(event.input.path) : "";
      if (!normalizedReadPath) return undefined;

      const absoluteReadPath = resolve(ctx.cwd, normalizedReadPath);
      const matchedRequiredPaths = Array.from(pendingReadPaths).filter(
        (requiredPath) => resolve(ctx.cwd, requiredPath) === absoluteReadPath,
      );
      if (matchedRequiredPaths.length === 0) return undefined;

      for (const requiredPath of matchedRequiredPaths) {
        pendingReadPaths.delete(requiredPath);
        if (pendingEditedProposalPath && requiredPath === pendingEditedProposalPath) {
          pendingEditedProposalReadToolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        }
      }

      return undefined;
    }

    if (event.toolName !== "edit" && event.toolName !== "write") {
      return undefined;
    }
    const toolName = event.toolName;
    let resolvedChangeReason: string | undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked ${toolName}: no interactive UI available for approval` };
    }

    while (true) {
      if (denyHold) {
        return {
          block: true,
          reason: "Developer denied the previous change. Wait for a new user prompt.",
        };
      }

      const proposedInput = normalizeToolCallInput(toolName, event.input);
      sanitizeToolCallInput(event, toolName, proposedInput);
      if (!proposedInput.path) {
        return {
          block: true,
          reason: `Blocked ${toolName}: include a valid path and retry.`,
        };
      }
      if (toolName === "edit" && (proposedInput as EditInput).edits.length === 0) {
        return {
          block: true,
          reason: "Blocked edit: include at least one valid oldText/newText edit block and retry.",
        };
      }

      const normalizedInputPath = proposedInput.path;
      if (!isPathInReviewScope(normalizedInputPath, reviewScope)) {
        consumePendingChangeReason();
        return undefined;
      }

      if (pendingReadPaths.size > 0) {
        return {
          block: true,
          reason: `Blocked ${toolName}: read ${joinPathList(Array.from(pendingReadPaths))} first.`,
        };
      }

      if (!resolvedChangeReason) {
        resolvedChangeReason = normalizeReasonValue(proposedInput.reason) || consumePendingChangeReason();
      }
      proposedInput.reason = resolvedChangeReason ?? "";
      if (!proposedInput.reason) {
        return {
          block: true,
          reason: `Blocked ${toolName}: call ${DIFFLOOP_REASON_TOOL_NAME} first with a concrete reason, then retry one ${toolName} proposal.`,
        };
      }

      let writeCandidatePath: string | undefined;
      if (toolName === "write") {
        await candidateFiles.clearSessionDirectory();
        writeCandidatePath = await persistEditedProposal(
          ctx.cwd,
          "write",
          proposedInput.path,
          proposedInput as WriteInput,
          await candidateFiles.ensureDirectory(ctx),
        );
      }

      const review = await buildReviewData(ctx, toolName, proposedInput, writeCandidatePath);

      const action = await handleReviewAction(ctx, review);

      if (action === "approve") {
        const editPreviewValidation = review.editPreviewValidation;
        if (!editPreviewValidation || editPreviewValidation.canApprove) {
          return undefined;
        }

        await clearPendingEditedProposal();

        if (editPreviewValidation.missingTarget) {
          const missingTargetCandidatePath = await persistEditedProposal(
            ctx.cwd,
            "edit",
            review.path,
            proposedInput as EditInput,
            await candidateFiles.ensureDirectory(ctx),
          );
          pendingEditedProposalPath = missingTargetCandidatePath;
          setPendingReadRequirements(missingTargetCandidatePath);
          ctx.ui.notify(
            `Approval blocked for edit ${review.path}; target file is missing, switching to candidate-file replanning.`,
            "warning",
          );
          return {
            block: true,
            reason: buildMissingTargetEditInstruction(review.path, proposedInput as EditInput, missingTargetCandidatePath),
          };
        }

        setPendingReadRequirements(review.path);
        ctx.ui.notify(`Approval blocked for edit ${review.path}; automatic replanning guidance applied.`, "warning");
        return {
          block: true,
          reason: buildBlockedEditApprovalInstruction(review.path, proposedInput as EditInput, review),
        };
      }

      if (action === "deny") {
        denyHold = true;
        await clearReadRequirements();
        ctx.abort();
        return {
          block: true,
          reason: "",
        };
      }

      if (typeof action === "object" && action.action === "steer") {
        const message = buildSteeringInstruction(toolName, review.path, action.steering, writeCandidatePath);
        if (!message) {
          ctx.ui.notify("Enter steering instructions to send feedback to the agent.", "warning");
          continue;
        }

        return { block: true, reason: message };
      }

      const updated = await editProposal(ctx, toolName, proposedInput);
      if (!updated) {
        continue;
      }

      await clearPendingEditedProposal();
      const editedProposalPath = await persistEditedProposal(
        ctx.cwd,
        toolName,
        review.path,
        updated,
        await candidateFiles.ensureDirectory(ctx),
      );
      const requireTargetRead = await pathExists(resolve(ctx.cwd, review.path));
      pendingEditedProposalPath = editedProposalPath;
      setPendingReadRequirements(requireTargetRead ? review.path : undefined, editedProposalPath);
      return {
        block: true,
        reason: buildEditedProposalInstruction(toolName, review.path, editedProposalPath, requireTargetRead),
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const isEditOrWriteError = (event.toolName === "edit" || event.toolName === "write") && event.isError;
    if (isEditOrWriteError) {
      const failedPath = typeof event.input?.path === "string" ? normalizePath(event.input.path) : "";
      if (!failedPath) return undefined;

      await clearPendingEditedProposal();
      setPendingReadRequirements(failedPath);

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

    const isSuccessfulReadOfEditedProposal =
      event.toolName === "read" &&
      Boolean(pendingEditedProposalReadToolCallId) &&
      event.toolCallId === pendingEditedProposalReadToolCallId &&
      !event.isError;

    if (!isSuccessfulReadOfEditedProposal) return undefined;

    await clearPendingEditedProposal();
    return undefined;
  });
}

async function buildReviewData(
  ctx: ExtensionContext,
  toolName: "write" | "edit",
  input: WriteInput | EditInput,
  candidatePath?: string,
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

    const summary = [
      existingContent === undefined ? "Operation: create new file" : "Operation: overwrite existing file",
      `Size: ${writeInput.content.length} characters across ${contentLines} lines`,
      ...(candidatePath ? [`Candidate file: ${candidatePath}`] : []),
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
    const candidatePreview = await buildEditedProposalCandidate(ctx.cwd, "edit", path, editInput);
    return {
      toolName,
      path,
      reason,
      summary: [
        ...summary,
        "Preview warning: target file does not exist on disk",
        "Fallback preview: generated candidate content from proposed edit blocks",
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
            { kind: "warning", text: "! Approval is blocked for edit on missing files; replan with write using candidate content." },
            ...buildWriteContentPreview(candidatePreview),
          ],
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
) {
  if (!ctx.hasUI) return;

  const baseStatusText = enabled ? ctx.ui.theme.fg("warning", "diffloop on") : ctx.ui.theme.fg("dim", "diffloop off");
  const updateStatusText = availableUpdateVersion
    ? ctx.ui.theme.fg("accent", ` update v${availableUpdateVersion} available`)
    : "";

  ctx.ui.setStatus(DIFFLOOP_REVIEW_STATUS, `${baseStatusText}${updateStatusText}`);
  if (announce) {
    ctx.ui.notify(`Diffloop ${enabled ? "on" : "off"}`, enabled ? "warning" : "info");
  }
}

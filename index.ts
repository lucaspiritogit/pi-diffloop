import {
  createEditToolDefinition,
  createWriteToolDefinition,
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

export { clearCandidateFilesDirectory } from "./candidate-files";
export { buildReviewBodyLines } from "./review-ui";
export { buildSteeringInstruction } from "./tool-hooks";

const DIFFLOOP_REVIEW_STATUS = "diffloop";
const baseEditToolDefinition = createEditToolDefinition(process.cwd());
const baseWriteToolDefinition = createWriteToolDefinition(process.cwd());

const EditParams = Type.Object(
  {
    ...baseEditToolDefinition.parameters.properties,
    reason: Type.String({
      description: "Why this edit is needed for review.",
    }),
  },
  { additionalProperties: false },
);

const WriteParams = Type.Object(
  {
    ...baseWriteToolDefinition.parameters.properties,
    reason: Type.String({
      description: "Why this write is needed for review.",
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

function resolveExecutionRoot(ctx: ExtensionContext | undefined): string {
  if (ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0) {
    return ctx.cwd;
  }
  return process.cwd();
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

  const clearPendingEditedProposal = async () => {
    pendingEditedProposalPath = undefined;
    pendingEditedProposalReadToolCallId = undefined;
    await candidateFiles.clearSessionDirectory();
  };

  const clearReadRequirements = async () => {
    pendingReadPaths.clear();
    await clearPendingEditedProposal();
  };

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
    await candidateFiles.clearSessionDirectory();
    candidateFiles.setSessionFromContext(ctx);
    await clearStaleCandidateDirectories();
    displayDiffloopStatus(ctx, enabled);
  });

  pi.on("input", async (event, ctx) => {
    if (!denyHold) return;
    if (event.source === "extension") return;

    denyHold = false;
    await clearReadRequirements();
    if (ctx.hasUI) {
      ctx.ui.notify("Deny lock cleared. Reviewing can continue on the new prompt.", "info");
    }
  });

  pi.registerTool({
    ...baseEditToolDefinition,
    description: "Edit one file using exact oldText/newText blocks. Include a non-empty `reason`.",
    promptSnippet: "Use edit for precise replacements and include a concrete `reason`.",
    promptGuidelines: [
      ...(baseEditToolDefinition.promptGuidelines ?? []),
      "Keep `reason` specific to this file change and avoid generic prose.",
    ],
    parameters: EditParams,
    prepareArguments: normalizeEditArguments,
    async execute(toolCallId, params, signal, onUpdate, toolCtx) {
      const nativeEditTool = createEditToolDefinition(resolveExecutionRoot(toolCtx));
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
    ...baseWriteToolDefinition,
    description: "Create or overwrite one file. Include a non-empty `reason`.",
    promptGuidelines: [
      ...(baseWriteToolDefinition.promptGuidelines ?? []),
      "Keep `reason` concrete and file-specific.",
    ],
    parameters: WriteParams,
    prepareArguments: normalizeWriteArguments,
    async execute(toolCallId, params, signal, onUpdate, toolCtx) {
      const nativeWriteTool = createWriteToolDefinition(resolveExecutionRoot(toolCtx));
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
      const hadPendingRequirements = pendingReadPaths.size > 0;
      let clearedAnyRequirement = false;
      if (readPath) {
        const absoluteReadPath = resolve(ctx.cwd, readPath);
        for (const requiredPath of Array.from(pendingReadPaths)) {
          if (resolve(ctx.cwd, requiredPath) !== absoluteReadPath) {
            continue;
          }

          pendingReadPaths.delete(requiredPath);
          clearedAnyRequirement = true;
          if (pendingEditedProposalPath && requiredPath === pendingEditedProposalPath) {
            pendingEditedProposalReadToolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
          }
        }
      }

      if (hadPendingRequirements && clearedAnyRequirement && pendingReadPaths.size === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify("Read requirements satisfied. Agent may now choose edit/write.", "info");
        }
      }
      return undefined;
    }

    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked ${event.toolName}: no interactive UI available for approval` };
    }

    while (true) {
      if (denyHold) {
        return {
          block: true,
          reason: "Developer denied the previous change. Wait for a new user prompt.",
        };
      }

      if (typeof event.input.path === "string") {
        event.input.path = normalizePath(event.input.path);
      }

      const input = event.input as WriteInput | EditInput;
      const normalizedInputPath = normalizePath(input.path || "");
      if (!isPathInReviewScope(normalizedInputPath, reviewScope)) {
        return undefined;
      }

      if (pendingReadPaths.size > 0) {
        const requiredReadList = Array.from(pendingReadPaths);
        return {
          block: true,
          reason: `Blocked ${event.toolName}: read ${joinPathList(requiredReadList)} first.`,
        };
      }

      if (typeof input.reason !== "string" || !input.reason.trim()) {
        return {
          block: true,
          reason: `Blocked ${event.toolName}: include a non-empty reason and retry.`,
        };
      }

      input.reason = input.reason.trim();

      let writeCandidatePath: string | undefined;
      if (event.toolName === "write") {
        await candidateFiles.clearSessionDirectory();
        writeCandidatePath = await persistEditedProposal(
          ctx.cwd,
          "write",
          input.path,
          input as WriteInput,
          await candidateFiles.ensureDirectory(ctx),
        );
      }

      const review = await buildReviewData(
        ctx,
        event.toolName,
        event.input as WriteInput | EditInput,
        writeCandidatePath,
      );

      const action = await handleReviewAction(ctx, review);

      if (action === "approve") {
        if (review.editPreviewValidation && !review.editPreviewValidation.canApprove) {
          await clearPendingEditedProposal();
          pendingReadPaths.clear();

          if (review.editPreviewValidation.missingTarget) {
            const missingTargetCandidatePath = await persistEditedProposal(
              ctx.cwd,
              "edit",
              review.path,
              input as EditInput,
              await candidateFiles.ensureDirectory(ctx),
            );
            pendingEditedProposalPath = missingTargetCandidatePath;
            pendingReadPaths.add(missingTargetCandidatePath);
            ctx.ui.notify(
              `Approval blocked for edit ${review.path}; target file is missing, switching to candidate-file replanning.`,
              "warning",
            );
            return {
              block: true,
              reason: buildMissingTargetEditInstruction(review.path, input as EditInput, missingTargetCandidatePath),
            };
          }

          pendingReadPaths.add(review.path);
          ctx.ui.notify(`Approval blocked for edit ${review.path}; automatic replanning guidance applied.`, "warning");
          return {
            block: true,
            reason: buildBlockedEditApprovalInstruction(review.path, input as EditInput, review),
          };
        }

        return undefined;
      }

      if (action === "deny") {
        denyHold = true;
        await clearReadRequirements();
        ctx.abort();
        return {
          block: true,
          reason: "Developer denied the proposal. Stop and wait for a new user prompt.",
        };
      }

      if (typeof action === "object" && action.action === "steer") {
        const message = buildSteeringInstruction(event.toolName, review.path, action.steering, writeCandidatePath);
        if (!message) {
          ctx.ui.notify("Enter steering instructions to send feedback to the agent.", "warning");
          continue;
        }

        return { block: true, reason: message };
      }

      const updated = await editProposal(ctx, event.toolName, event.input as WriteInput | EditInput);
      if (!updated) {
        continue;
      }

      await clearPendingEditedProposal();
      const editedProposalPath = await persistEditedProposal(
        ctx.cwd,
        event.toolName,
        review.path,
        updated,
        await candidateFiles.ensureDirectory(ctx),
      );
      const requireTargetRead = await pathExists(resolve(ctx.cwd, review.path));
      pendingEditedProposalPath = editedProposalPath;
      pendingReadPaths.clear();
      if (requireTargetRead) {
        pendingReadPaths.add(review.path);
      }
      pendingReadPaths.add(editedProposalPath);
      return {
        block: true,
        reason: buildEditedProposalInstruction(event.toolName, review.path, editedProposalPath, requireTargetRead),
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if ((event.toolName === "edit" || event.toolName === "write") && event.isError) {
      const failedPath = typeof event.input?.path === "string" ? normalizePath(event.input.path) : "";
      if (failedPath) {
        await clearPendingEditedProposal();
        pendingReadPaths.clear();
        pendingReadPaths.add(failedPath);

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
      return undefined;
    }

    if (event.toolName !== "read") return undefined;
    if (!pendingEditedProposalReadToolCallId) return undefined;
    if (event.toolCallId !== pendingEditedProposalReadToolCallId) return undefined;
    if (event.isError) return undefined;

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

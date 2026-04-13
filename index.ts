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
import { spawnSync } from "node:child_process";
import { constants, rmSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { normalizePath, pathExists, pushLine, pushWrappedLine } from "./utils";

type DiffPreviewLineKind = "meta" | "context" | "add" | "remove" | "warning";

type DiffPreviewLine = {
  kind: DiffPreviewLineKind;
  text: string;
};

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
    missingTarget?: boolean;
  };
};

const DIFFLOOP_REVIEW_STATUS = "diffloop";
const DIFFLOOP_TEMP_ROOT_DIR = join(tmpdir(), "diffloop");
const CANDIDATE_FILES_ROOT_DIR = join(DIFFLOOP_TEMP_ROOT_DIR, "candidate-files");
const CANDIDATE_FILES_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EPHEMERAL_SESSION_DIR = "ephemeral";
const baseEditToolDefinition = createEditToolDefinition(process.cwd());
const baseWriteToolDefinition = createWriteToolDefinition(process.cwd());
const PROCESS_CLEANUP_REGISTERED_KEY = "__diffloopCandidateFilesCleanupRegistered";
const PROCESS_CLEANUP_DIRECTORIES_KEY = "__diffloopCandidateFilesCleanupDirectories";

type GlobalCleanupState = typeof globalThis & {
  [PROCESS_CLEANUP_REGISTERED_KEY]?: boolean;
  [PROCESS_CLEANUP_DIRECTORIES_KEY]?: Set<string>;
};

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

function sanitizeSessionDirectoryName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || EPHEMERAL_SESSION_DIR;
}

function resolveSessionDirectoryName(ctx: ExtensionContext | undefined): string {
  const rawSessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!rawSessionFile || typeof rawSessionFile !== "string") {
    return EPHEMERAL_SESSION_DIR;
  }

  const lastSegment = rawSessionFile.split(/[\\/]/).pop() || rawSessionFile;
  const fileWithoutExt = lastSegment.replace(/\.[^.]+$/, "");
  return sanitizeSessionDirectoryName(fileWithoutExt);
}

function clearCandidateFilesDirectorySync(directory = DIFFLOOP_TEMP_ROOT_DIR) {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
  }
}

export async function clearCandidateFilesDirectory(directory = DIFFLOOP_TEMP_ROOT_DIR) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
  }
}

function getTrackedCleanupDirectories(state: GlobalCleanupState): Set<string> {
  if (!state[PROCESS_CLEANUP_DIRECTORIES_KEY]) {
    state[PROCESS_CLEANUP_DIRECTORIES_KEY] = new Set<string>();
  }
  return state[PROCESS_CLEANUP_DIRECTORIES_KEY]!;
}

function trackCleanupDirectory(directory: string) {
  const state = globalThis as GlobalCleanupState;
  getTrackedCleanupDirectories(state).add(directory);
}

function untrackCleanupDirectory(directory: string) {
  const state = globalThis as GlobalCleanupState;
  getTrackedCleanupDirectories(state).delete(directory);
}

async function clearStaleCandidateDirectories(
  rootDirectory = CANDIDATE_FILES_ROOT_DIR,
  maxAgeMs = CANDIDATE_FILES_MAX_AGE_MS,
) {
  let entries;
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true, encoding: "utf8" });
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const absolutePath = join(rootDirectory, entry.name);
    let entryStats;
    try {
      entryStats = await stat(absolutePath);
    } catch {
      continue;
    }

    if (now - entryStats.mtimeMs < maxAgeMs) continue;
    await clearCandidateFilesDirectory(absolutePath);
  }
}

function registerCandidateFilesProcessCleanup() {
  const state = globalThis as GlobalCleanupState;
  if (state[PROCESS_CLEANUP_REGISTERED_KEY]) return;

  state[PROCESS_CLEANUP_REGISTERED_KEY] = true;

  const runCleanup = () => {
    for (const directory of getTrackedCleanupDirectories(state)) {
      clearCandidateFilesDirectorySync(directory);
    }
  };

  process.once("exit", runCleanup);
  process.once("SIGINT", () => {
    runCleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    runCleanup();
    process.exit(143);
  });
}

export default function reviewChanges(pi: ExtensionAPI) {
  registerCandidateFilesProcessCleanup();
  void clearStaleCandidateDirectories();

  let enabled = true;
  const pendingReadPaths = new Set<string>();
  let pendingEditedProposalPath: string | undefined;
  let pendingEditedProposalReadToolCallId: string | undefined;
  let candidateFilesDirectory: string | undefined;
  let sessionDirectoryName = EPHEMERAL_SESSION_DIR;
  let denyHold = false;

  const ensureCandidateFilesDirectory = async (ctx?: ExtensionContext): Promise<string> => {
    if (ctx) {
      sessionDirectoryName = resolveSessionDirectoryName(ctx);
    }

    if (candidateFilesDirectory) return candidateFilesDirectory;

    await mkdir(DIFFLOOP_TEMP_ROOT_DIR, { recursive: true, mode: 0o700 });
    await mkdir(CANDIDATE_FILES_ROOT_DIR, { recursive: true, mode: 0o700 });
    try {
      await chmod(DIFFLOOP_TEMP_ROOT_DIR, 0o700);
      await chmod(CANDIDATE_FILES_ROOT_DIR, 0o700);
    } catch {
    }

    const sessionDir = join(CANDIDATE_FILES_ROOT_DIR, sessionDirectoryName);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    try {
      await chmod(sessionDir, 0o700);
    } catch {
    }

    candidateFilesDirectory = sessionDir;
    trackCleanupDirectory(sessionDir);
    return sessionDir;
  };

  const clearSessionCandidateFiles = async () => {
    if (!candidateFilesDirectory) return;

    const currentDirectory = candidateFilesDirectory;
    candidateFilesDirectory = undefined;
    untrackCleanupDirectory(currentDirectory);
    await clearCandidateFilesDirectory(currentDirectory);
  };

  const clearPendingEditedProposal = async () => {
    pendingEditedProposalPath = undefined;
    pendingEditedProposalReadToolCallId = undefined;
    await clearSessionCandidateFiles();
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
    await clearSessionCandidateFiles();
    sessionDirectoryName = resolveSessionDirectoryName(ctx);
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
        await clearSessionCandidateFiles();
        writeCandidatePath = await persistEditedProposal(
          ctx.cwd,
          "write",
          input.path,
          input as WriteInput,
          await ensureCandidateFilesDirectory(ctx),
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
              await ensureCandidateFilesDirectory(ctx),
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
        await ensureCandidateFilesDirectory(ctx),
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

  pi.on("tool_result", async (event) => {
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
  steering: string,
  candidatePath?: string,
): string | undefined {
  const feedback = steering.trim();
  if (!feedback) return undefined;

  const normalizedPath = normalizePath(path);
  return [
    `Revise ${toolName} for ${normalizedPath}.`,
    `Feedback: ${feedback}`,
    toolName === "write" && candidatePath ? `If ${normalizedPath} is missing, read ${candidatePath}.` : undefined,
    candidatePath ? "Candidate files are draft-only; verify repo context before proposing." : undefined,
    "Submit one revised edit/write proposal if still needed.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildEditedProposalInstruction(
  toolName: "write" | "edit",
  path: string,
  editedProposalPath: string,
  requireTargetRead: boolean,
): string {
  const normalizedPath = normalizePath(path);
  return [
    `Replace the previous ${toolName} proposal for ${normalizedPath}.`,
    requireTargetRead
      ? `Read ${normalizedPath} and ${editedProposalPath}.`
      : `Read ${editedProposalPath}. ${normalizedPath} does not exist yet.`,
    `Use ${editedProposalPath} as the candidate source.`,
    "Candidate is draft-only; reconcile with repository dependencies/callers.",
    "Submit one updated edit/write proposal.",
  ].join("\n");
}

function joinPathList(paths: string[]): string {
  if (paths.length === 0) return "required files";
  if (paths.length === 1) return paths[0]!;
  if (paths.length === 2) return `${paths[0]} and ${paths[1]}`;
  return `${paths.slice(0, -1).join(", ")}, and ${paths[paths.length - 1]}`;
}

type NativeEditCandidateResult = { ok: true; content: string } | { ok: false; error: string };

async function runNativeEditCandidate(cwd: string, path: string, edits: EditBlock[]): Promise<NativeEditCandidateResult> {
  let candidateContent: string | undefined;

  const nativeEdit = createEditToolDefinition(cwd, {
    operations: {
      async access(absolutePath: string) {
        await access(absolutePath, constants.R_OK | constants.W_OK);
      },
      async readFile(absolutePath: string) {
        return readFile(absolutePath);
      },
      async writeFile(_absolutePath: string, content: string) {
        candidateContent = content;
      },
    },
  });

  try {
    await nativeEdit.execute(
      "diffloop-edited-proposal-candidate",
      { path, edits },
      undefined,
      undefined,
      undefined as any,
    );
    return {
      ok: true,
      content: candidateContent ?? "",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyEditsBestEffort(baseContent: string, edits: EditBlock[]): string {
  let content = baseContent;
  for (const edit of edits) {
    content = content.replace(edit.oldText, edit.newText);
  }
  return content;
}

async function buildEditedProposalCandidate(
  cwd: string,
  toolName: "write" | "edit",
  path: string,
  input: WriteInput | EditInput,
): Promise<string> {
  if (toolName === "write") {
    const writeInput = input as WriteInput;
    return writeInput.content;
  }

  const normalizedPath = normalizePath(path);
  const editInput = normalizeEditInput(input as EditInput);
  const previewCandidate = await runNativeEditCandidate(cwd, normalizedPath, editInput.edits);
  if (previewCandidate.ok) {
    return previewCandidate.content;
  }

  const absolutePath = resolve(cwd, normalizedPath);
  let baseContent = "";
  try {
    baseContent = await readFile(absolutePath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  return applyEditsBestEffort(baseContent, editInput.edits);
}

async function persistEditedProposal(
  cwd: string,
  toolName: "write" | "edit",
  path: string,
  input: WriteInput | EditInput,
  candidateDirectory: string,
): Promise<string> {
  await mkdir(candidateDirectory, { recursive: true, mode: 0o700 });

  const normalizedPath = normalizePath(path);
  const extension = extname(normalizedPath) || ".txt";
  const baseName = normalizedPath.split(/[\\/]/).pop() || "file";
  const baseWithoutExt = baseName.endsWith(extension) ? baseName.slice(0, -extension.length) : baseName;
  const safeBase = baseWithoutExt.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const fileName = `candidate-${safeBase}-${timestamp}-${random}${extension}`;
  const absolutePath = join(candidateDirectory, fileName);
  const candidateSource = await buildEditedProposalCandidate(cwd, toolName, normalizedPath, input);

  await writeFile(absolutePath, candidateSource, { encoding: "utf8", mode: 0o600 });
  return absolutePath;
}

function buildBlockedEditApprovalInstruction(path: string, input: EditInput, review: ReviewData): string {
  const normalizedPath = normalizePath(path);
  const currentReason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;
  const validationErrors = review.editPreviewValidation?.errors ?? ["Native preview validation failed."];

  return [
    `Do not execute the previous edit for ${normalizedPath}.`,
    `Native preview failed: ${validationErrors.join("; ")}`,
    currentReason ? `Previous reason: ${currentReason}` : undefined,
    `Read ${normalizedPath}, then propose a new exact-match edit with unique oldText blocks.`,
    "If exact matching still fails, switch to write with full file content.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildMissingTargetEditInstruction(path: string, input: EditInput, candidatePath: string): string {
  const normalizedPath = normalizePath(path);
  const currentReason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;

  return [
    `Do not execute the previous edit for ${normalizedPath}.`,
    "Target file is missing, so edit cannot apply.",
    currentReason ? `Previous reason: ${currentReason}` : undefined,
    `Read ${candidatePath}.`,
    "Treat candidate as draft-only; check repo dependencies before final proposal.",
    `Then submit one write proposal for ${normalizedPath} from that candidate content.`,
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

function buildWriteContentPreview(content: string): DiffPreviewLine[] {
  if (content.length === 0) {
    return [{ kind: "meta", text: "(empty file)" }];
  }

  const lines = content.split("\n");
  return lines.map((line) => ({ kind: "add", text: `+${line}` }));
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

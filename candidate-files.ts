import { createEditToolDefinition, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { constants, rmSync } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { EditBlock, EditInput, WriteInput } from "./review-types";
import { normalizePath } from "./utils";

const DIFFLOOP_TEMP_ROOT_DIR = join(tmpdir(), "diffloop");
const CANDIDATE_FILES_ROOT_DIR = join(DIFFLOOP_TEMP_ROOT_DIR, "candidate-files");
const CANDIDATE_FILES_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EPHEMERAL_SESSION_DIR = "ephemeral";
const PROCESS_CLEANUP_REGISTERED_KEY = "__diffloopCandidateFilesCleanupRegistered";
const PROCESS_CLEANUP_DIRECTORIES_KEY = "__diffloopCandidateFilesCleanupDirectories";

type GlobalCleanupState = typeof globalThis & {
  [PROCESS_CLEANUP_REGISTERED_KEY]?: boolean;
  [PROCESS_CLEANUP_DIRECTORIES_KEY]?: Set<string>;
};

export function sanitizeSessionDirectoryName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || EPHEMERAL_SESSION_DIR;
}

export function resolveSessionDirectoryName(ctx: ExtensionContext | undefined): string {
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

export async function clearStaleCandidateDirectories(
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

export function registerCandidateFilesProcessCleanup() {
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

export function createCandidateFilesSessionManager() {
  let candidateFilesDirectory: string | undefined;
  let sessionDirectoryName = EPHEMERAL_SESSION_DIR;

  const ensureDirectory = async (ctx?: ExtensionContext): Promise<string> => {
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

  const clearSessionDirectory = async () => {
    if (!candidateFilesDirectory) return;

    const currentDirectory = candidateFilesDirectory;
    candidateFilesDirectory = undefined;
    untrackCleanupDirectory(currentDirectory);
    await clearCandidateFilesDirectory(currentDirectory);
  };

  const setSessionFromContext = (ctx: ExtensionContext) => {
    sessionDirectoryName = resolveSessionDirectoryName(ctx);
  };

  return {
    ensureDirectory,
    clearSessionDirectory,
    setSessionFromContext,
  };
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

function normalizeCandidateEditInput(input: EditInput): EditInput {
  const edits = Array.isArray(input.edits)
    ? input.edits
        .filter(
          (edit): edit is EditBlock =>
            Boolean(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string",
        )
        .map((edit) => ({ oldText: edit.oldText, newText: edit.newText }))
    : [];

  return {
    path: normalizePath(input.path || ""),
    reason: typeof input.reason === "string" ? input.reason.trim() : "",
    edits,
  };
}

export async function buildEditedProposalCandidate(
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
  const editInput = normalizeCandidateEditInput(input as EditInput);
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

export async function persistEditedProposal(
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

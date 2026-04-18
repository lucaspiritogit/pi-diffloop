import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizePath } from "../lib/utils.js";

export const REVIEWED_APPLY_SNIPPET_MAX_CHARS = 48_000;

export type PendingReviewedMutationLike = {
  toolName: "write" | "edit";
  path: string;
  toolCallId?: string;
};

export function buildReviewedMutationInstruction(toolName: "write" | "edit", path: string): string {
  const normalizedPath = normalizePath(path) || "(unknown path)";
  return [
    `Diffloop applied the developer-reviewed ${toolName} proposal for ${normalizedPath}.`,
    "The proposal may have been changed in the review editor, so the applied result can differ from the model's earlier stated diff.",
    "The snapshot below is read from disk after this tool finished; base your summary on it, not on the earlier tool-call diff.",
    "Compare it to the task and submit further edit/write calls only when something is still missing or incorrect.",
    "Do not resubmit identical tool arguments for content that is already on disk.",
  ].join(" ");
}

export function buildReviewedMutationSteeringBrief(toolName: "write" | "edit", path: string): string {
  const normalizedPath = normalizePath(path) || "(unknown path)";
  return `Diffloop: developer-reviewed ${toolName} applied for ${normalizedPath}. The tool result starts with the on-disk file snapshot—use that as the source of truth for what changed.`;
}

export async function readUtf8SnippetAfterApply(cwd: string, path: string): Promise<string> {
  const normalized = normalizePath(path);
  if (!normalized) return "(invalid path)";
  try {
    const raw = await readFile(resolve(cwd, normalized), "utf8");
    if (raw.length <= REVIEWED_APPLY_SNIPPET_MAX_CHARS) return raw;
    return `${raw.slice(0, REVIEWED_APPLY_SNIPPET_MAX_CHARS)}\n\n… (${raw.length - REVIEWED_APPLY_SNIPPET_MAX_CHARS} more characters truncated) …`;
  } catch (error: any) {
    if (error?.code === "ENOENT") return "(file not found on disk)";
    throw error;
  }
}

export async function buildReviewedApplyToolResultContent(
  ctx: ExtensionContext,
  pending: PendingReviewedMutationLike,
  inputPath: string | undefined,
): Promise<{ text: string; steeringBrief: string }> {
  const path = pending.path || inputPath || "";
  const instruction = buildReviewedMutationInstruction(pending.toolName, path);
  let snapshot: string;
  try {
    snapshot = await readUtf8SnippetAfterApply(ctx.cwd, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    snapshot = `(could not read file after apply: ${message})`;
  }
  const followUp = [
    instruction,
    "",
    `--- ${normalizePath(path)} on disk after developer-reviewed apply ---`,
    "",
    snapshot,
  ].join("\n");
  return {
    text: followUp,
    steeringBrief: buildReviewedMutationSteeringBrief(pending.toolName, path),
  };
}

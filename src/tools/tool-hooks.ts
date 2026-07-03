import type { EditInput, ReviewData, WriteInput } from "../review/review-types.js";
import { normalizePath } from "../lib/utils.js";
import { normalizeEditInput } from "./edit-write-input.js";

export function buildSteeringInstruction(
  toolName: "write" | "edit",
  path: string,
  steering: string,
): string | undefined {
  const feedback = steering.trim();
  if (!feedback) return undefined;

  const normalizedPath = normalizePath(path);
  return [
    `Revise ${toolName} for ${normalizedPath}.`,
    `Feedback: ${feedback}`,
    "Submit one revised edit/write proposal if still needed.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildDeveloperEditedProposalInstruction(
  toolName: "write" | "edit",
  input: WriteInput | EditInput,
): string {
  const normalizedPath = normalizePath(input.path);
  return [
    `The developer edited your proposed ${toolName} for ${normalizedPath}.`,
    "Do not execute the original proposal.",
    "Review the developer-edited proposal below for syntax, formatting, and behavior regressions.",
    "Preserve the developer's intended change; if it is invalid, repair it instead of deleting it.",
    "The revised proposal must include every developer-added non-whitespace line unless it is impossible to apply.",
    "Submit one revised edit/write proposal for review.",
    "",
    formatDeveloperEditedProposal(toolName, input),
  ].join("\n");
}

function formatDeveloperEditedProposal(toolName: "write" | "edit", input: WriteInput | EditInput): string {
  const maxLength = 8000;
  const proposal =
    toolName === "write"
      ? (input as WriteInput).content
      : normalizeEditInput(input as EditInput).edits
          .map((edit, index) =>
            [`Block ${index + 1} oldText:`, edit.oldText, "", `Block ${index + 1} newText:`, edit.newText].join("\n"),
          )
          .join("\n\n");

  const body = proposal.length <= maxLength ? proposal : `${proposal.slice(0, maxLength)}\n... [truncated]`;
  return `--- developer-edited ${toolName} proposal ---\n${body}`;
}

export function joinPathList(paths: string[]): string {
  if (paths.length === 0) return "required files";
  if (paths.length === 1) return paths[0]!;
  if (paths.length === 2) return `${paths[0]} and ${paths[1]}`;
  return `${paths.slice(0, -1).join(", ")}, and ${paths[paths.length - 1]}`;
}

export function buildBlockedEditApprovalInstruction(path: string, review: ReviewData): string {
  const normalizedPath = normalizePath(path);
  const validationErrors = review.editPreviewValidation?.errors ?? ["Native preview validation failed."];

  return [
    `Do not execute the previous edit for ${normalizedPath}.`,
    `Native preview failed: ${validationErrors.join("; ")}`,
    `Read ${normalizedPath}, then propose a new exact-match edit with unique oldText blocks.`,
    "If exact matching still fails, switch to write with full file content.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildMissingTargetEditInstruction(path: string): string {
  const normalizedPath = normalizePath(path);

  return [
    `Do not execute the previous edit for ${normalizedPath}.`,
    "Target file is missing, so edit cannot apply.",
    `Submit one write proposal for ${normalizedPath}.`,
    "If needed, regenerate full content from repository context before writing.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

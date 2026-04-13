import type { EditInput, ReviewData } from "./review-types";
import { normalizePath } from "./utils";

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

export function buildEditedProposalInstruction(
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

export function joinPathList(paths: string[]): string {
  if (paths.length === 0) return "required files";
  if (paths.length === 1) return paths[0]!;
  if (paths.length === 2) return `${paths[0]} and ${paths[1]}`;
  return `${paths.slice(0, -1).join(", ")}, and ${paths[paths.length - 1]}`;
}

export function buildBlockedEditApprovalInstruction(path: string, input: EditInput, review: ReviewData): string {
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

export function buildMissingTargetEditInstruction(path: string, input: EditInput, candidatePath: string): string {
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

import type { EditToolInput, WriteToolInput } from "@mariozechner/pi-coding-agent";
import type { StructuredDiff } from "../diff/structured-diff.js";

export type DiffPreviewLineKind = "meta" | "context" | "add" | "remove" | "warning";

export type DiffPreviewLine = {
  kind: DiffPreviewLineKind;
  text: string;
};

export type ReviewAction = "approve" | "steer" | "edit" | "deny";
export type ReviewDecision = Exclude<ReviewAction, "steer"> | { action: "steer"; steering: string };

export type ReviewData = {
  toolName: "write" | "edit";
  path: string;
  reason: string;
  summary: string[];
  changes: Array<{ title: string; lines: DiffPreviewLine[]; diffModel?: StructuredDiff }>;
  editPreviewValidation?: {
    canApprove: boolean;
    errors: string[];
    missingTarget?: boolean;
  };
};

export type EditBlock = EditToolInput["edits"][number];
export type EditInput = EditToolInput & { reason: string };
export type WriteInput = WriteToolInput & { reason: string };

export type NativeEditPreviewResult = { ok: true; diff?: string } | { ok: false; error: string; diff?: string };

export type NativeEditBlockStatus = {
  index: number;
  ok: boolean;
  kind?: "notFound" | "notUnique" | "invalid";
  error?: string;
};

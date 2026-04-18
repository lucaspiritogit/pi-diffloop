import type { EditBlock, EditInput, WriteInput } from "../review/review-types.js";
import { normalizePath } from "../lib/utils.js";

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

export function normalizeReasonValue(reason: unknown): string {
  return typeof reason === "string" ? reason.trim() : "";
}

export function normalizeEditInput(input: EditInput): EditInput {
  const edits = Array.isArray(input.edits)
    ? input.edits
        .filter(
          (edit: { oldText?: unknown; newText?: unknown }): edit is EditBlock =>
            Boolean(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string",
        )
        .map((edit: EditBlock) => ({ oldText: edit.oldText, newText: edit.newText }))
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

export function normalizeToolCallInput(toolName: "write" | "edit", input: unknown): WriteInput | EditInput {
  if (toolName === "write") {
    return normalizeWriteInput(input);
  }

  const normalizedEditArgs = normalizeEditArguments(input as any);
  const raw = (normalizedEditArgs && typeof normalizedEditArgs === "object" ? normalizedEditArgs : {}) as EditInput;
  return normalizeEditInput(raw);
}

export function normalizeReviewModeAction(args?: string): "on" | "off" | "toggle" | "status" | "invalid" {
  const action = (args ?? "status").trim().toLowerCase();

  if (!action || action === "status") return "status";
  if (action === "on" || action === "enable" || action === "enabled") return "on";
  if (action === "off" || action === "disable" || action === "disabled") return "off";
  if (action === "toggle") return "toggle";
  return "invalid";
}

export function sanitizeToolCallInput(
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

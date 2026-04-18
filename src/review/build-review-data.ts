import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyEditBlocksToContent,
  buildEditValidationErrors,
  buildNativePreviewWarnings,
  buildPreviewFromNativeEditDiff,
  buildWriteContentPreview,
  getNativeEditBlockStatuses,
  runNativeEditPreview,
  runNativeWritePreview,
} from "../diff-preview.js";
import type { EditBlock, EditInput, NativeEditBlockStatus, ReviewData, WriteInput } from "../review-types.js";
import { buildStructuredDiff } from "../structured-diff.js";
import { normalizePath } from "../utils.js";
import { normalizeEditInput } from "../tools/edit-write-input.js";

export async function buildReviewData(
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
  const validBlocks = blockStatuses.filter((status: NativeEditBlockStatus) => status.ok).length;
  const invalidBlocks = blockStatuses.length - validBlocks;
  const preview = await runNativeEditPreview(ctx.cwd, path, editInput.edits);
  const warningLines = [
    ...blockStatuses.flatMap((status: NativeEditBlockStatus) => buildNativePreviewWarnings(status)),
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
  return normalized.edits.map((edit: EditBlock) => edit.newText).join("\n");
}

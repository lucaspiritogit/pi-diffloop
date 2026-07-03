import { isToolCallEventType, type ExtensionContext, type ToolCallEvent, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { handleReviewAction } from "../ui/review-screen.js";
import { isPathInReviewScope, loadDiffloopConfig } from "./review-scope.js";
import type { EditInput, ReviewData, ReviewPlan, WriteInput } from "./review-types.js";
import type { DiffloopRuntimeState } from "./runtime-state.js";
import type { DiffViewMode } from "../ui/review-diff-render.js";
import {
  buildBlockedEditApprovalInstruction,
  buildMissingTargetEditInstruction,
  buildSteeringInstruction,
  joinPathList,
} from "../tools/tool-hooks.js";
import { normalizePath } from "../lib/utils.js";

type BlockMeta = { code: string; toolName?: "write" | "edit"; path?: string };
type BlockWithReason = (
  reason: string,
  key?: string,
  meta?: BlockMeta,
) => { block: true; reason: string };

type DecisionAction = "approve" | "deny" | "steer" | "edit";

type ReviewPipelineDeps = {
  state: DiffloopRuntimeState;
  diffViewMode: "split" | "inline";
  onDiffViewModeChange: (mode: DiffViewMode) => void;
  planToolName: string;
  normalizeReviewPlan: (input: unknown) => ReviewPlan | undefined;
  normalizeToolCallInput: (toolName: "write" | "edit", input: unknown) => WriteInput | EditInput;
  sanitizeToolCallInput: (
    event: { input: unknown },
    toolName: "write" | "edit",
    normalizedInput: WriteInput | EditInput,
  ) => void;
  buildReviewData: (
    ctx: ExtensionContext,
    toolName: "write" | "edit",
    input: WriteInput | EditInput,
    plan: ReviewPlan | undefined,
  ) => Promise<ReviewData>;
  editProposal: (
    ctx: ExtensionContext,
    toolName: "write" | "edit",
    input: WriteInput | EditInput,
  ) => Promise<WriteInput | EditInput | undefined>;
  blockWithReason: BlockWithReason;
  onDecision: (decision: { action: DecisionAction; toolName: "write" | "edit"; path: string }) => void;
};

export async function handleReviewToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  deps: ReviewPipelineDeps,
): Promise<ToolCallEventResult | undefined> {
  const isPlanToolCall = event.toolName === deps.planToolName;

  if (!deps.state.getEnabled() && isPlanToolCall) {
    return deps.blockWithReason(
      `Blocked ${deps.planToolName}: diffloop is off. Enable it with /diffloop on before using this tool.`,
      `${deps.planToolName}:disabled`,
      { code: "plan-tool-disabled" },
    );
  }

  if (
    !deps.state.getEnabled() ||
    (!isPlanToolCall &&
      !isToolCallEventType("edit", event) &&
      !isToolCallEventType("write", event) &&
      !isToolCallEventType("read", event))
  ) {
    return undefined;
  }

  if (isPlanToolCall) {
    const plan = deps.normalizeReviewPlan(event.input);
    if (!plan) {
      return deps.blockWithReason(
        `Blocked ${deps.planToolName}: include at least a goal or currentStep and retry.`,
        `${deps.planToolName}:empty`,
        { code: "plan-tool-empty" },
      );
    }
    deps.state.setReviewPlan(plan);
    event.input = plan;
    return undefined;
  }

  if (isToolCallEventType("read", event)) {
    const pendingReadPaths = deps.state.listPendingReadPaths();
    if (pendingReadPaths.length === 0) return undefined;

    if (!event.input.path) return undefined;

    const matchedRequiredPaths = deps.state.matchAndConsumeReadPath(ctx.cwd, event.input.path);
    if (matchedRequiredPaths.length === 0) return undefined;

    return undefined;
  }

  if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) {
    return undefined;
  }

  const toolName = event.toolName;
  let pendingEditedWriteInput: WriteInput | undefined;
  let proposalEditedInReview = false;

  if (!ctx.hasUI) {
    return deps.blockWithReason(
      `Blocked ${toolName}: no interactive UI available for approval`,
      `${toolName}:no-ui`,
      { code: "no-ui", toolName },
    );
  }

  while (true) {
    if (deps.state.getDenyHold()) {
      return deps.blockWithReason(
        "Developer denied the previous change. Wait for a new user prompt.",
        "deny-hold",
        { code: "deny-hold", toolName },
      );
    }

    const proposedInput = deps.normalizeToolCallInput(toolName, event.input);
    deps.sanitizeToolCallInput(event, toolName, proposedInput);
    if (!proposedInput.path) {
      return deps.blockWithReason(
        `Blocked ${toolName}: include a valid path and retry.`,
        `${toolName}:missing-path`,
        { code: "missing-path", toolName },
      );
    }
    if (toolName === "edit" && (proposedInput as EditInput).edits.length === 0) {
      return deps.blockWithReason(
        "Blocked edit: include at least one valid oldText/newText edit block and retry.",
        "edit:missing-edits",
        { code: "missing-edits", toolName },
      );
    }

    const normalizedInputPath = proposedInput.path;
    deps.state.refreshConfig(loadDiffloopConfig());
    if (!isPathInReviewScope(normalizedInputPath, deps.state.getReviewScope())) {
      return undefined;
    }

    const pendingReadPaths = deps.state.listPendingReadPathsForPath(ctx.cwd, normalizedInputPath);
    if (pendingReadPaths.length > 0) {
      return deps.blockWithReason(
        `Blocked ${toolName}: read ${joinPathList(pendingReadPaths)} first.`,
        `${toolName}:pending-read:${pendingReadPaths.sort().join("|")}`,
        { code: "pending-read", toolName, path: normalizedInputPath },
      );
    }

    const review = await deps.buildReviewData(ctx, toolName, proposedInput, deps.state.getReviewPlan());
    if (toolName === "edit" && review.editPreviewValidation && !review.editPreviewValidation.canApprove) {
      if (review.editPreviewValidation.missingTarget) {
        ctx.ui.notify(
          `Preview warning for edit ${review.path}; target file is missing, request a write proposal instead.`,
          "warning",
        );
        return deps.blockWithReason(
          buildMissingTargetEditInstruction(review.path),
          `edit:missing-target:${review.path}`,
          { code: "missing-target", toolName, path: review.path },
        );
      }

      deps.state.setPendingReadRequirements(review.path);
      ctx.ui.notify(
        `Preview warning for edit ${review.path}; automatic read-first replanning guidance applied.`,
        "warning",
      );
      return deps.blockWithReason(
        buildBlockedEditApprovalInstruction(review.path, review),
        `edit:invalid-preview:${review.path}:${(review.editPreviewValidation.errors ?? []).join("|")}`,
        { code: "invalid-preview", toolName, path: review.path },
      );
    }

    const action = await handleReviewAction(ctx, review, deps.diffViewMode, deps.onDiffViewModeChange);

    if (action === "approve") {
      if (toolName === "write" && pendingEditedWriteInput) {
        deps.sanitizeToolCallInput(event, toolName, pendingEditedWriteInput);
        deps.state.queuePendingWriteOverride(event.toolCallId, pendingEditedWriteInput.path, pendingEditedWriteInput.content);
      }
      if (toolName === "edit" && proposalEditedInReview) {
        const editInput = proposedInput as EditInput;
        const normalizedEditPath = normalizePath(editInput.path);
        if (normalizedEditPath) {
          try {
            const baseSnapshot = await readFile(resolve(ctx.cwd, normalizedEditPath), "utf8");
            deps.state.queuePendingEditOverride(event.toolCallId, editInput.path, editInput.edits, baseSnapshot);
          } catch {
            ctx.ui.notify(`Could not read ${normalizedEditPath} before applying reviewed edit; override skipped.`, "warning");
          }
        }
      }
      if (proposalEditedInReview) {
        const approvedPath = normalizePath(
          toolName === "write" && pendingEditedWriteInput ? pendingEditedWriteInput.path : proposedInput.path,
        );
        deps.state.queuePendingReviewedMutation(toolName, event.toolCallId, approvedPath);
      }
      deps.onDecision({
        action: "approve",
        toolName,
        path: review.path,
      });
      return undefined;
    }

    if (action === "deny") {
      deps.state.setDenyHold(true);
      deps.state.clearReadRequirements();
      deps.onDecision({
        action: "deny",
        toolName,
        path: review.path,
      });
      return deps.blockWithReason(
        `Diffloop denied ${toolName} for ${review.path}. No file changes were applied. Stop and wait for a new user prompt.`,
        `${toolName}:denied:${review.path}`,
        { code: "denied", toolName, path: review.path },
      );
    }

    if (typeof action === "object" && action.action === "steer") {
      const message = buildSteeringInstruction(toolName, review.path, action.steering);
      if (!message) {
        ctx.ui.notify("Enter steering instructions to send feedback to the agent.", "warning");
        continue;
      }

      deps.onDecision({
        action: "steer",
        toolName,
        path: review.path,
      });
      return deps.blockWithReason(
        `${message}\nNo file changes were applied.`,
        `${toolName}:steered:${review.path}`,
        { code: "steered", toolName, path: review.path },
      );
    }

    const updated = await deps.editProposal(ctx, toolName, proposedInput);
    if (!updated) {
      continue;
    }

    if (toolName === "write") {
      pendingEditedWriteInput = updated as WriteInput;
    }
    proposalEditedInReview = true;

    deps.sanitizeToolCallInput(event, toolName, updated);
    deps.onDecision({
      action: "edit",
      toolName,
      path: normalizePath(updated.path),
    });
  }
}

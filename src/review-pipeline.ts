import { isToolCallEventType, type ExtensionContext, type ToolCallEvent, type ToolCallEventResult } from "@mariozechner/pi-coding-agent";
import { handleReviewAction } from "./ui/review-screen.js";
import { isPathInReviewScope, loadDiffloopConfig } from "./review-scope.js";
import type { EditInput, ReviewData, WriteInput } from "./review-types.js";
import type { DiffloopRuntimeState } from "./runtime-state.js";
import {
  buildBlockedEditApprovalInstruction,
  buildMissingTargetEditInstruction,
  buildSteeringInstruction,
  joinPathList,
} from "./tool-hooks.js";
import { normalizePath } from "./utils.js";

type BlockMeta = { code: string; toolName?: "write" | "edit"; path?: string };
type BlockWithReason = (
  reason: string,
  key?: string,
  meta?: BlockMeta,
) => { block: true; reason: string };

type DecisionAction = "approve" | "deny" | "steer" | "edit";

type ReviewPipelineDeps = {
  state: DiffloopRuntimeState;
  reasonToolName: string;
  normalizeReasonValue: (reason: unknown) => string;
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
  ) => Promise<ReviewData>;
  editProposal: (
    ctx: ExtensionContext,
    toolName: "write" | "edit",
    input: WriteInput | EditInput,
  ) => Promise<WriteInput | EditInput | undefined>;
  sendSteeringFeedback: (message: string) => boolean;
  blockWithReason: BlockWithReason;
  onDecision: (decision: { action: DecisionAction; toolName: "write" | "edit"; path: string; reason?: string }) => void;
  onDenyAbort: (ctx: ExtensionContext) => void;
};

export async function handleReviewToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  deps: ReviewPipelineDeps,
): Promise<ToolCallEventResult | undefined> {
  const isReasonToolCall = event.toolName === deps.reasonToolName;

  if (!deps.state.getEnabled() && isReasonToolCall) {
    return deps.blockWithReason(
      `Blocked ${deps.reasonToolName}: diffloop is off. Enable it with /diffloop on before using this tool.`,
      `${deps.reasonToolName}:disabled`,
      { code: "reason-tool-disabled" },
    );
  }

  if (
    !deps.state.getEnabled() ||
    (!isReasonToolCall &&
      !isToolCallEventType("edit", event) &&
      !isToolCallEventType("write", event) &&
      !isToolCallEventType("read", event))
  ) {
    return undefined;
  }

  if (isReasonToolCall) {
    const reason = deps.normalizeReasonValue((event.input as { reason?: unknown } | undefined)?.reason);
    if (!reason) {
      return deps.blockWithReason(
        `Blocked ${deps.reasonToolName}: include a non-empty reason and retry.`,
        `${deps.reasonToolName}:empty`,
        { code: "reason-tool-empty" },
      );
    }

    deps.state.queuePendingChangeReason(reason);
    event.input = { reason };
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
  let resolvedChangeReason: string | undefined;
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
      deps.state.consumePendingChangeReason();
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

    if (!resolvedChangeReason) {
      resolvedChangeReason = deps.normalizeReasonValue(proposedInput.reason) || deps.state.consumePendingChangeReason();
    }
    proposedInput.reason = resolvedChangeReason ?? "";
    if (!proposedInput.reason) {
      return deps.blockWithReason(
        `Blocked ${toolName}: call ${deps.reasonToolName} first with a concrete reason, then retry one ${toolName} proposal.`,
        `${toolName}:missing-reason`,
        { code: "missing-reason", toolName, path: normalizedInputPath },
      );
    }

    const review = await deps.buildReviewData(ctx, toolName, proposedInput);
    if (toolName === "edit" && review.editPreviewValidation && !review.editPreviewValidation.canApprove) {
      if (review.editPreviewValidation.missingTarget) {
        ctx.ui.notify(
          `Preview warning for edit ${review.path}; target file is missing, request a write proposal instead.`,
          "warning",
        );
        return deps.blockWithReason(
          buildMissingTargetEditInstruction(review.path, proposedInput as EditInput),
          `edit:missing-target:${review.path}:${proposedInput.reason}`,
          { code: "missing-target", toolName, path: review.path },
        );
      }

      deps.state.setPendingReadRequirements(review.path);
      ctx.ui.notify(
        `Preview warning for edit ${review.path}; automatic read-first replanning guidance applied.`,
        "warning",
      );
      return deps.blockWithReason(
        buildBlockedEditApprovalInstruction(review.path, proposedInput as EditInput, review),
        `edit:invalid-preview:${review.path}:${proposedInput.reason}:${(review.editPreviewValidation.errors ?? []).join("|")}`,
        { code: "invalid-preview", toolName, path: review.path },
      );
    }

    const action = await handleReviewAction(ctx, review);

    if (action === "approve") {
      if (toolName === "write" && pendingEditedWriteInput) {
        deps.sanitizeToolCallInput(event, toolName, pendingEditedWriteInput);
        deps.state.queuePendingWriteOverride(event.toolCallId, pendingEditedWriteInput.path, pendingEditedWriteInput.content);
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
        reason: proposedInput.reason,
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
        reason: proposedInput.reason,
      });
      deps.onDenyAbort(ctx);
      return {
        block: true,
        reason: "",
      };
    }

    if (typeof action === "object" && action.action === "steer") {
      const message = buildSteeringInstruction(toolName, review.path, action.steering);
      if (!message) {
        ctx.ui.notify("Enter steering instructions to send feedback to the agent.", "warning");
        continue;
      }

      const sent = deps.sendSteeringFeedback(message);
      deps.onDecision({
        action: "steer",
        toolName,
        path: review.path,
        reason: proposedInput.reason,
      });
      return { block: true, reason: sent ? "" : message };
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
      reason: deps.normalizeReasonValue(updated.reason),
    });
  }
}

import {
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyEditBlocksToContent } from "../diff/diff-preview.js";
import { buildReviewData } from "../review/build-review-data.js";
import { editProposal } from "../review/proposal-editor.js";
import { handleReviewToolCall } from "../review/review-pipeline.js";
import { loadDiffloopConfig, saveEnabledToConfig, saveRequireReasonToConfig } from "../review/review-scope.js";
import { buildReviewedApplyToolResultContent } from "../review/reviewed-apply-followup.js";
import { createDiffloopRuntimeState } from "../review/runtime-state.js";
import {
  normalizeReasonValue,
  normalizeReviewModeAction,
  normalizeToolCallInput,
  sanitizeToolCallInput,
} from "../tools/edit-write-input.js";
import { normalizePath } from "../lib/utils.js";
import { clearSyntaxTokenCache } from "../diff/syntax-highlight.js";
import { clearReviewBodyCache, clearStyleCache } from "../ui/review-diff-render.js";

const DIFFLOOP_REVIEW_STATUS = "diffloop";
const DIFFLOOP_REASON_TOOL_NAME = "set_change_reason";
const DIFFLOOP_REASON_GUIDANCE =
  `Before every edit/write tool call, call ${DIFFLOOP_REASON_TOOL_NAME} first with one concrete reason tied to repository context and behavior impact.`;

export default function registerDiffloopExtension(pi: ExtensionAPI) {
  const state = createDiffloopRuntimeState(loadDiffloopConfig());

  const sendSteeringFeedback = (message: string): boolean => {
    try {
      pi.sendUserMessage(message, { deliverAs: "steer" });
      return true;
    } catch {
      return false;
    }
  };

  const blockWithReason = (reason: string, _key?: string, _meta?: { code: string; toolName?: "write" | "edit"; path?: string }) => {
    return state.buildBlockedResult(reason);
  };

  const syncReasonToolActivation = () => {
    const api = pi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
    if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;

    const activeTools = api.getActiveTools();
    const withoutReasonTool = activeTools.filter((toolName) => toolName !== DIFFLOOP_REASON_TOOL_NAME);

    if (state.getEnabled() && state.getRequireReason()) {
      if (!activeTools.includes(DIFFLOOP_REASON_TOOL_NAME)) {
        api.setActiveTools([...withoutReasonTool, DIFFLOOP_REASON_TOOL_NAME]);
      }
      return;
    }

    if (withoutReasonTool.length !== activeTools.length) {
      api.setActiveTools(withoutReasonTool);
    }
  };

  pi.registerCommand("diffloop", {
    description: "Set diffloop on, off, toggle it, or show the current status",
    handler: async (args, ctx) => {
      const action = normalizeReviewModeAction(args);
      const enabled = state.getEnabled();

      if (action === "invalid") {
        ctx.ui.notify("Usage: /diffloop [on|off|toggle|status]", "error");
        displayDiffloopStatus(ctx, enabled, state.getRequireReason(), false);
        return;
      }

      const wasEnabled = enabled;
      let nextEnabled = enabled;
      if (action === "toggle") nextEnabled = !enabled;
      if (action === "on") nextEnabled = true;
      if (action === "off") nextEnabled = false;
      state.setEnabled(nextEnabled);

      if (action !== "status") {
        try {
          saveEnabledToConfig(nextEnabled);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to persist diffloop state: ${message}`, "warning");
        }
      }

      if (wasEnabled && !nextEnabled) {
        state.setDenyHold(false);
        state.clearPendingChangeReasons();
        state.clearReadRequirements();
      }

      syncReasonToolActivation();
      displayDiffloopStatus(ctx, state.getEnabled(), state.getRequireReason(), true);
    },
  });

  pi.registerCommand("diffloop-reason", {
    description: "Set required change reasons on, off, toggle, or show status",
    handler: async (args, ctx) => {
      const action = normalizeReviewModeAction(args);
      const requireReason = state.getRequireReason();

      if (action === "invalid") {
        ctx.ui.notify("Usage: /diffloop-reason [on|off|toggle|status]", "error");
        displayDiffloopStatus(ctx, state.getEnabled(), requireReason, false);
        return;
      }

      let nextRequireReason = requireReason;
      if (action === "toggle") nextRequireReason = !requireReason;
      if (action === "on") nextRequireReason = true;
      if (action === "off") nextRequireReason = false;
      state.setRequireReason(nextRequireReason);

      if (action !== "status") {
        try {
          saveRequireReasonToConfig(nextRequireReason);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Failed to persist diffloop reason state: ${message}`, "warning");
        }
        if (!nextRequireReason) {
          state.clearPendingChangeReasons();
        }
        syncReasonToolActivation();
      }

      displayDiffloopStatus(ctx, state.getEnabled(), nextRequireReason, false);
      if (action !== "status" && ctx.hasUI) {
        ctx.ui.notify(
          nextRequireReason ? "Change reasons required" : "Change reasons optional",
          nextRequireReason ? "warning" : "info",
        );
      }
    },
  });

  pi.registerTool?.({
    name: DIFFLOOP_REASON_TOOL_NAME,
    label: DIFFLOOP_REASON_TOOL_NAME,
    description: "Record the reason for the next edit/write proposal.",
    promptSnippet: "Record reason before each edit/write",
    promptGuidelines: [
      `Before each edit/write call, use ${DIFFLOOP_REASON_TOOL_NAME} with one concrete reason tied to current code.`,
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Concrete reason for the next file mutation." }),
    }),
    async execute(_toolCallId, params: { reason: string }) {
      return {
        content: [{ type: "text" as const, text: `Reason recorded: ${params.reason.trim()}` }],
        details: undefined,
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.getEnabled() || !state.getRequireReason()) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${DIFFLOOP_REASON_GUIDANCE}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    state.refreshConfig(loadDiffloopConfig());
    state.resetForSessionBoundary();
    syncReasonToolActivation();
    displayDiffloopStatus(ctx, state.getEnabled(), state.getRequireReason(), false);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state.resetForSessionBoundary();
    displayDiffloopStatus(ctx, state.getEnabled(), state.getRequireReason(), false);
  });

  pi.on("session_shutdown", async () => {
    state.resetForSessionBoundary();
    clearSyntaxTokenCache();
    clearStyleCache();
    clearReviewBodyCache();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      state.clearPendingChangeReasons();
    }

    if (!state.getDenyHold()) return;
    if (event.source === "extension") return;

    state.setDenyHold(false);
    state.clearReadRequirements();
    if (ctx.hasUI) {
      ctx.ui.notify("Deny lock cleared. Reviewing can continue on the new prompt.", "info");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    return handleReviewToolCall(event, ctx, {
      state,
      reasonToolName: DIFFLOOP_REASON_TOOL_NAME,
      normalizeReasonValue,
      normalizeToolCallInput,
      sanitizeToolCallInput,
      buildReviewData,
      editProposal,
      sendSteeringFeedback,
      blockWithReason,
      onDecision: () => {},
      onDenyAbort: (pipelineCtx: ExtensionContext) => {
        pipelineCtx.abort();
      },
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    const inputPath = typeof event.input?.path === "string" ? event.input.path : undefined;
    const pendingReviewedMutation =
      event.toolName === "write" || event.toolName === "edit"
        ? state.consumePendingReviewedMutation(event.toolName, event.toolCallId, inputPath)
        : undefined;

    if (isWriteToolResult(event)) {
      const pendingWriteOverride = state.consumePendingWriteOverride(event.toolCallId, inputPath);
      if (pendingWriteOverride && !event.isError) {
        const normalizedOverridePath = normalizePath(pendingWriteOverride.path || inputPath || "");
        const absolutePath = resolve(ctx.cwd, normalizedOverridePath);
        try {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, pendingWriteOverride.content, "utf8");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Failed to apply reviewed write override for ${normalizedOverridePath}: ${message}`,
              "warning",
            );
          }
          return {
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: `Diffloop warning: failed to apply reviewed write override for ${normalizedOverridePath}: ${message}`,
              },
            ],
            details: event.details,
          };
        }
      }
    }

    if (event.toolName === "edit") {
      const pendingEditOverride = state.consumePendingEditOverride(event.toolCallId, inputPath);
      if (pendingEditOverride && !event.isError) {
        const normalizedOverridePath = normalizePath(pendingEditOverride.path || inputPath || "");
        const absolutePath = resolve(ctx.cwd, normalizedOverridePath);
        const applied = applyEditBlocksToContent(pendingEditOverride.baseSnapshot, pendingEditOverride.edits);
        if (!applied.ok) {
          const message = applied.error;
          if (ctx.hasUI) {
            ctx.ui.notify(`Failed to apply reviewed edit override for ${normalizedOverridePath}: ${message}`, "warning");
          }
          return {
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: `Diffloop warning: failed to apply reviewed edit override for ${normalizedOverridePath}: ${message}`,
              },
            ],
            details: event.details,
          };
        }
        try {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, applied.afterText, "utf8");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) {
            ctx.ui.notify(`Failed to write reviewed edit override for ${normalizedOverridePath}: ${message}`, "warning");
          }
          return {
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: `Diffloop warning: failed to write reviewed edit override for ${normalizedOverridePath}: ${message}`,
              },
            ],
            details: event.details,
          };
        }
      }
    }

    const isEditOrWriteError = (event.toolName === "edit" || event.toolName === "write") && event.isError;
    if (isEditOrWriteError) {
      const failedPath = typeof event.input?.path === "string" ? normalizePath(event.input.path) : "";
      if (!failedPath) return undefined;

      state.setPendingReadRequirements(failedPath);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Detected ${event.toolName} execution error on ${failedPath}; enforcing read-first retry before the next edit/write.`,
          "warning",
        );
      }

      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `Diffloop recovery: read ${failedPath} and then submit one revised ${event.toolName} proposal.`,
          },
        ],
      };
    }

    if (!event.isError && pendingReviewedMutation) {
      const { text, steeringBrief } = await buildReviewedApplyToolResultContent(ctx, pendingReviewedMutation, inputPath);
      sendSteeringFeedback(steeringBrief);
      return {
        content: [{ type: "text" as const, text }],
        details: event.details,
      };
    }
    return undefined;
  });
}

function displayDiffloopStatus(
  ctx: ExtensionContext,
  enabled: boolean,
  requireReason: boolean,
  announce = false,
) {
  if (!ctx.hasUI) return;

  const reviewStatus = enabled ? ctx.ui.theme.fg("warning", "diffloop on") : ctx.ui.theme.fg("dim", "diffloop off");
  const reasonStatus = requireReason
    ? ctx.ui.theme.fg("accent", "review reason on")
    : ctx.ui.theme.fg("dim", "review reason off");
  const baseStatusText = enabled ? `${reviewStatus} • ${reasonStatus}` : reviewStatus;

  ctx.ui.setStatus(DIFFLOOP_REVIEW_STATUS, baseStatusText);
  if (announce) {
    const message = !enabled
      ? "Diffloop off"
      : requireReason
        ? "Diffloop on"
        : "Diffloop reasons optional";
    ctx.ui.notify(message, enabled ? "warning" : "info");
  }
}

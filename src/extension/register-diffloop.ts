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
import { loadDiffloopConfig, saveEnabledToConfig } from "../review/review-scope.js";
import { buildReviewedApplyToolResultContent } from "../review/reviewed-apply-followup.js";
import { createDiffloopRuntimeState } from "../review/runtime-state.js";
import {
  normalizeReviewModeAction,
  normalizeToolCallInput,
  sanitizeToolCallInput,
} from "../tools/edit-write-input.js";
import type { ReviewPlan } from "../review/review-types.js";
import { normalizePath } from "../lib/utils.js";
import { clearSyntaxTokenCache } from "../diff/syntax-highlight.js";
import { clearReviewBodyCache, clearStyleCache } from "../ui/review-diff-render.js";

const DIFFLOOP_REVIEW_STATUS = "diffloop";
const DIFFLOOP_PLAN_TOOL_NAME = "set_change_plan";
const LEGACY_REASON_TOOL_NAME = "set_change_reason";
const DIFFLOOP_PLAN_GUIDANCE = [
  `Before the first edit/write for a task, call ${DIFFLOOP_PLAN_TOOL_NAME} with a compact plan.`,
  `Refresh ${DIFFLOOP_PLAN_TOOL_NAME} whenever the goal, current step, or planned files change.`,
  "Keep the plan short: one goal, one current step, and expected files.",
  "Order plannedFiles in the review order that is easiest to validate: lower-level dependencies first, then helpers/functions/services, then routes/controllers/UI. If there is no clear dependency chain, use the cleanest reading order for the task.",
].join("\n");

function normalizeList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean);
}

function normalizeReviewPlan(input: unknown): ReviewPlan | undefined {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const plan: ReviewPlan = {
    goal: typeof raw.goal === "string" ? raw.goal.trim() : "",
    currentStep: typeof raw.currentStep === "string" ? raw.currentStep.trim() : "",
    plannedFiles: normalizeList(raw.plannedFiles).map(normalizePath).filter(Boolean),
  };
  return plan.goal || plan.currentStep ? plan : undefined;
}

export default function registerDiffloopExtension(pi: ExtensionAPI) {
  const state = createDiffloopRuntimeState(loadDiffloopConfig());

  const blockWithReason = (reason: string, _key?: string, _meta?: { code: string; toolName?: "write" | "edit"; path?: string }) => {
    return state.buildBlockedResult(reason);
  };

  const syncPlanToolActivation = () => {
    const api = pi as Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">>;
    if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") return;

    const activeTools = api.getActiveTools();
    const withoutDiffloopTools = activeTools.filter(
      (toolName) => toolName !== DIFFLOOP_PLAN_TOOL_NAME && toolName !== LEGACY_REASON_TOOL_NAME,
    );

    if (state.getEnabled()) {
      if (!activeTools.includes(DIFFLOOP_PLAN_TOOL_NAME) || withoutDiffloopTools.length !== activeTools.length - 1) {
        api.setActiveTools([...withoutDiffloopTools, DIFFLOOP_PLAN_TOOL_NAME]);
      }
      return;
    }

    if (withoutDiffloopTools.length !== activeTools.length) {
      api.setActiveTools(withoutDiffloopTools);
    }
  };

  pi.registerCommand("diffloop", {
    description: "Set diffloop on, off, toggle it, or show the current status",
    handler: async (args, ctx) => {
      const action = normalizeReviewModeAction(args);
      const enabled = state.getEnabled();

      if (action === "invalid") {
        ctx.ui.notify("Usage: /diffloop [on|off|toggle|status]", "error");
        displayDiffloopStatus(ctx, enabled, false);
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
        state.clearReviewPlan();
        state.clearReadRequirements();
      }

      syncPlanToolActivation();
      displayDiffloopStatus(ctx, state.getEnabled(), true);
    },
  });

  pi.registerTool?.({
    name: DIFFLOOP_PLAN_TOOL_NAME,
    label: DIFFLOOP_PLAN_TOOL_NAME,
    description: "Record the current task plan shown above diffloop reviews.",
    promptSnippet: "Record compact task plan before editing",
    promptGuidelines: [
      `Before the first edit/write call, use ${DIFFLOOP_PLAN_TOOL_NAME} with a compact task plan.`,
      `Refresh ${DIFFLOOP_PLAN_TOOL_NAME} when the approach or planned files change.`,
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Overall user-facing goal for the task." }),
      currentStep: Type.String({ description: "What the next edit/write is trying to accomplish." }),
      plannedFiles: Type.Array(Type.String(), {
        description:
          "Files expected to be edited or written, ordered for review from lower-level dependencies to higher-level callers or UI.",
      }),
    }),
    async execute(_toolCallId, params: ReviewPlan) {
      return {
        content: [{ type: "text" as const, text: `Plan recorded: ${params.goal.trim() || params.currentStep.trim()}` }],
        details: undefined,
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.getEnabled()) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${DIFFLOOP_PLAN_GUIDANCE}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    state.refreshConfig(loadDiffloopConfig());
    state.resetForSessionBoundary();
    syncPlanToolActivation();
    displayDiffloopStatus(ctx, state.getEnabled(), false);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state.resetForSessionBoundary();
    displayDiffloopStatus(ctx, state.getEnabled(), false);
  });

  pi.on("session_shutdown", async () => {
    state.resetForSessionBoundary();
    clearSyntaxTokenCache();
    clearStyleCache();
    clearReviewBodyCache();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") {
      state.clearReviewPlan();
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
      diffViewMode: state.getDiffViewMode(),
      onDiffViewModeChange: state.setDiffViewMode,
      planToolName: DIFFLOOP_PLAN_TOOL_NAME,
      normalizeReviewPlan,
      normalizeToolCallInput,
      sanitizeToolCallInput,
      buildReviewData,
      editProposal,
      blockWithReason,
      onDecision: () => {},
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
    if (state.getEnabled() && isEditOrWriteError) {
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
      const { text } = await buildReviewedApplyToolResultContent(ctx, pendingReviewedMutation, inputPath);
      return {
        content: [{ type: "text" as const, text }],
        details: event.details,
      };
    }
    return undefined;
  });
}

function displayDiffloopStatus(ctx: ExtensionContext, enabled: boolean, announce = false) {
  if (!ctx.hasUI) return;

  const reviewStatus = enabled ? ctx.ui.theme.fg("warning", "diffloop on") : ctx.ui.theme.fg("dim", "diffloop off");

  ctx.ui.setStatus(DIFFLOOP_REVIEW_STATUS, reviewStatus);
  if (announce) {
    ctx.ui.notify(enabled ? "Diffloop on" : "Diffloop off", enabled ? "warning" : "info");
  }
}

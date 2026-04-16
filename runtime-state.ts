import { resolve } from "node:path";
import { loadDiffloopConfig, type DiffloopConfig } from "./review-scope";
import { normalizePath } from "./utils";

type PendingWriteOverride = {
  path: string;
  content: string;
  toolCallId?: string;
};

type PendingReviewedMutation = {
  toolName: "write" | "edit";
  path: string;
  toolCallId?: string;
};

export type BlockedToolCallResult = {
  block: true;
  reason: string;
};

export function createDiffloopRuntimeState(initialConfig: DiffloopConfig = loadDiffloopConfig()) {
  let enabled = initialConfig.enabled;
  let reviewScope = initialConfig.reviewScope;
  const pendingReadPaths = new Set<string>();
  const pendingChangeReasons: string[] = [];
  let denyHold = false;
  const pendingWriteOverridesByCallId = new Map<string, PendingWriteOverride>();
  const pendingWriteOverridesByPath = new Map<string, PendingWriteOverride[]>();
  const pendingReviewedMutationsByCallId = new Map<string, PendingReviewedMutation>();
  const pendingReviewedMutationsByToolPath = new Map<string, PendingReviewedMutation[]>();

  const buildBlockedResult = (reason: string): BlockedToolCallResult => {
    return { block: true, reason };
  };

  const clearPendingChangeReasons = () => {
    pendingChangeReasons.length = 0;
  };

  const queuePendingChangeReason = (reason: string): boolean => {
    const normalizedReason = reason.trim();
    if (!normalizedReason) return false;
    pendingChangeReasons.push(normalizedReason);
    return true;
  };

  const consumePendingChangeReason = (): string | undefined => {
    while (pendingChangeReasons.length > 0) {
      const reason = pendingChangeReasons.shift()?.trim();
      if (reason) return reason;
    }
    return undefined;
  };

  const clearReadRequirements = () => {
    pendingReadPaths.clear();
  };

  const setPendingReadRequirements = (...paths: Array<string | undefined>) => {
    pendingReadPaths.clear();
    for (const path of paths) {
      if (!path) continue;
      pendingReadPaths.add(path);
    }
  };

  const listPendingReadPaths = () => Array.from(pendingReadPaths);

  const listPendingReadPathsForPath = (cwd: string, path: string): string[] => {
    const normalizedTargetPath = normalizePath(path);
    if (!normalizedTargetPath) return [];

    const absoluteTargetPath = resolve(cwd, normalizedTargetPath);
    return Array.from(pendingReadPaths).filter((requiredPath) => resolve(cwd, requiredPath) === absoluteTargetPath);
  };

  const matchAndConsumeReadPath = (cwd: string, path: string): string[] => {
    const normalizedReadPath = normalizePath(path);
    if (!normalizedReadPath) return [];

    const absoluteReadPath = resolve(cwd, normalizedReadPath);
    const matchedRequiredPaths = Array.from(pendingReadPaths).filter(
      (requiredPath) => resolve(cwd, requiredPath) === absoluteReadPath,
    );

    for (const requiredPath of matchedRequiredPaths) {
      pendingReadPaths.delete(requiredPath);
    }
    return matchedRequiredPaths;
  };

  const removePendingWriteOverrideFromPathQueue = (pending: PendingWriteOverride) => {
    const queue = pendingWriteOverridesByPath.get(pending.path);
    if (!queue) return;
    const index = queue.findIndex((item) => item === pending);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      pendingWriteOverridesByPath.delete(pending.path);
    }
  };

  const clearPendingWriteOverrides = () => {
    pendingWriteOverridesByCallId.clear();
    pendingWriteOverridesByPath.clear();
  };

  const buildReviewedMutationKey = (toolName: "write" | "edit", path: string) => `${toolName}:${normalizePath(path)}`;

  const removePendingReviewedMutationFromPathQueue = (pending: PendingReviewedMutation) => {
    const key = buildReviewedMutationKey(pending.toolName, pending.path);
    const queue = pendingReviewedMutationsByToolPath.get(key);
    if (!queue) return;
    const index = queue.findIndex((item) => item === pending);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      pendingReviewedMutationsByToolPath.delete(key);
    }
  };

  const clearPendingReviewedMutations = () => {
    pendingReviewedMutationsByCallId.clear();
    pendingReviewedMutationsByToolPath.clear();
  };

  const queuePendingReviewedMutation = (
    toolName: "write" | "edit",
    toolCallId: string | undefined,
    path: string,
  ) => {
    const normalizedPath = normalizePath(path);
    const pending: PendingReviewedMutation = { toolName, path: normalizedPath, toolCallId };
    const key = buildReviewedMutationKey(toolName, normalizedPath);
    const queue = pendingReviewedMutationsByToolPath.get(key) ?? [];
    queue.push(pending);
    pendingReviewedMutationsByToolPath.set(key, queue);
    if (toolCallId) {
      pendingReviewedMutationsByCallId.set(toolCallId, pending);
    }
  };

  const consumePendingReviewedMutation = (
    toolName: "write" | "edit",
    toolCallId: string | undefined,
    inputPath: string | undefined,
  ) => {
    if (toolCallId) {
      const pendingById = pendingReviewedMutationsByCallId.get(toolCallId);
      if (pendingById && pendingById.toolName === toolName) {
        pendingReviewedMutationsByCallId.delete(toolCallId);
        removePendingReviewedMutationFromPathQueue(pendingById);
        return pendingById;
      }
    }

    if (!inputPath) return undefined;

    const key = buildReviewedMutationKey(toolName, inputPath);
    const queue = pendingReviewedMutationsByToolPath.get(key);
    if (!queue || queue.length === 0) return undefined;
    const pendingByPath = queue.shift();
    if (!pendingByPath) return undefined;
    if (queue.length === 0) {
      pendingReviewedMutationsByToolPath.delete(key);
    }
    if (pendingByPath.toolCallId) {
      pendingReviewedMutationsByCallId.delete(pendingByPath.toolCallId);
    }
    return pendingByPath;
  };

  const queuePendingWriteOverride = (toolCallId: string | undefined, path: string, content: string) => {
    const normalizedPath = normalizePath(path);
    const pending: PendingWriteOverride = { path: normalizedPath, content, toolCallId };
    const queue = pendingWriteOverridesByPath.get(normalizedPath) ?? [];
    queue.push(pending);
    pendingWriteOverridesByPath.set(normalizedPath, queue);
    if (toolCallId) {
      pendingWriteOverridesByCallId.set(toolCallId, pending);
    }
  };

  const consumePendingWriteOverride = (toolCallId: string | undefined, inputPath: string | undefined) => {
    if (toolCallId) {
      const pendingById = pendingWriteOverridesByCallId.get(toolCallId);
      if (pendingById) {
        pendingWriteOverridesByCallId.delete(toolCallId);
        removePendingWriteOverrideFromPathQueue(pendingById);
        return pendingById;
      }
    }

    if (!inputPath) return undefined;

    const normalizedPath = normalizePath(inputPath);
    const queue = pendingWriteOverridesByPath.get(normalizedPath);
    if (!queue || queue.length === 0) return undefined;
    const pendingByPath = queue.shift();
    if (!pendingByPath) return undefined;
    if (queue.length === 0) {
      pendingWriteOverridesByPath.delete(normalizedPath);
    }
    if (pendingByPath.toolCallId) {
      pendingWriteOverridesByCallId.delete(pendingByPath.toolCallId);
    }
    return pendingByPath;
  };

  const refreshConfig = (nextConfig: DiffloopConfig = loadDiffloopConfig()) => {
    enabled = nextConfig.enabled;
    reviewScope = nextConfig.reviewScope;
  };

  const resetForSessionBoundary = () => {
    clearReadRequirements();
    clearPendingChangeReasons();
    clearPendingWriteOverrides();
    clearPendingReviewedMutations();
    denyHold = false;
  };

  return {
    getEnabled: () => enabled,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    getReviewScope: () => reviewScope,
    refreshConfig,
    setDenyHold: (value: boolean) => {
      denyHold = value;
    },
    getDenyHold: () => denyHold,
    buildBlockedResult,
    clearPendingChangeReasons,
    queuePendingChangeReason,
    consumePendingChangeReason,
    clearReadRequirements,
    setPendingReadRequirements,
    listPendingReadPaths,
    listPendingReadPathsForPath,
    matchAndConsumeReadPath,
    clearPendingWriteOverrides,
    queuePendingWriteOverride,
    consumePendingWriteOverride,
    queuePendingReviewedMutation,
    consumePendingReviewedMutation,
    resetForSessionBoundary,
  };
}

export type DiffloopRuntimeState = ReturnType<typeof createDiffloopRuntimeState>;

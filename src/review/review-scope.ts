import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { normalizePath } from "../lib/utils.js";

export type ReviewScope = {
  includePatterns: string[];
  excludePatterns: string[];
  includeExtensions: string[];
  excludeExtensions: string[];
};

export type PlanConfig = {
  enabled: boolean;
  goal: boolean;
  current: boolean;
};

type ReviewScopeConfigShape = Partial<{
  includePatterns: unknown;
  excludePatterns: unknown;
  includeExtensions: unknown;
  excludeExtensions: unknown;
}>;

type DiffloopConfigShape = Partial<{
  enabled: boolean;
  diffViewMode: "split" | "inline";
  plan: Partial<{
    enabled: unknown;
    goal: unknown;
    current: unknown;
  }>;
  reviewScope: ReviewScopeConfigShape;
}> &
  ReviewScopeConfigShape;

export type DiffloopConfig = {
  enabled: boolean;
  diffViewMode: "split" | "inline";
  plan: PlanConfig;
  reviewScope: ReviewScope;
};

export const DIFFLOOP_CONFIG_FILE_NAME = "diffloop-config.json";

const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "diffloop-config.json");

let cachedConfig: DiffloopConfig | null = null;

function mergeConfig(target: Record<string, unknown>, source: unknown): void {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return;
  for (const key of Object.keys(source as object)) {
    if (key === "plan") {
      const value = (source as Record<string, unknown>)[key];
      target[key] = {
        ...(typeof target[key] === "object" && target[key] !== null && !Array.isArray(target[key])
          ? (target[key] as Record<string, unknown>)
          : {}),
        ...(typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}),
      };
    } else if (key === "reviewScope") {
      target[key] = (source as Record<string, unknown>)[key];
    } else {
      target[key] = (source as Record<string, unknown>)[key];
    }
  }
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

function parseList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  if (typeof input === "string") {
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeScopePath(value: string): string {
  return normalizePath(value).replace(/\\/g, "/");
}

function normalizePattern(pattern: string): string {
  return normalizeScopePath(pattern).replace(/^\.\//, "");
}

function normalizeExtension(token: string): string | undefined {
  const trimmed = token.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i++;
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegex(char);
  }
  regex += "$";
  return new RegExp(regex);
}

function matchesPattern(path: string, pattern: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  if (!normalizedPattern) return false;

  const matcher = globToRegExp(normalizedPattern);
  const normalizedPath = normalizeScopePath(path);
  if (normalizedPattern.includes("/")) {
    return matcher.test(normalizedPath);
  }

  return matcher.test(basename(normalizedPath)) || matcher.test(normalizedPath);
}

export function resolveDiffloopConfigPath(baseDir = __dirname): string {
  const localPath = join(baseDir, DIFFLOOP_CONFIG_FILE_NAME);
  if (existsSync(localPath)) return localPath;

  return resolve(baseDir, "..", DIFFLOOP_CONFIG_FILE_NAME);
}

function parseReviewScopeConfig(rawConfig: unknown): ReviewScope {
  const objectConfig = typeof rawConfig === "object" && rawConfig !== null ? (rawConfig as DiffloopConfigShape) : {};
  const source =
    typeof objectConfig.reviewScope === "object" && objectConfig.reviewScope !== null
      ? objectConfig.reviewScope
      : objectConfig;

  const includeExtensions = parseList(source.includeExtensions)
    .map(normalizeExtension)
    .filter((ext): ext is string => Boolean(ext));

  const excludeExtensions = parseList(source.excludeExtensions)
    .map(normalizeExtension)
    .filter((ext): ext is string => Boolean(ext));

  return {
    includePatterns: parseList(source.includePatterns).map(normalizePattern),
    excludePatterns: parseList(source.excludePatterns).map(normalizePattern),
    includeExtensions,
    excludeExtensions,
  };
}

function parseEnabled(rawConfig: unknown): boolean {
  if (!rawConfig || typeof rawConfig !== "object") return true;
  const enabledValue = (rawConfig as DiffloopConfigShape).enabled;
  return typeof enabledValue === "boolean" ? enabledValue : true;
}

function parseDiffViewMode(rawConfig: unknown): "split" | "inline" {
  if (!rawConfig || typeof rawConfig !== "object") return "split";
  const value = (rawConfig as DiffloopConfigShape).diffViewMode;
  if (value === "split" || value === "inline") return value;
  return "split";
}

function parsePlanConfig(rawConfig: unknown): PlanConfig {
  const rawPlan =
    rawConfig && typeof rawConfig === "object" && typeof (rawConfig as DiffloopConfigShape).plan === "object"
      ? (rawConfig as DiffloopConfigShape).plan
      : {};

  return {
    enabled: typeof rawPlan?.enabled === "boolean" ? rawPlan.enabled : true,
    goal: typeof rawPlan?.goal === "boolean" ? rawPlan.goal : true,
    current: typeof rawPlan?.current === "boolean" ? rawPlan.current : true,
  };
}

export function loadDiffloopConfig(configPath = resolveDiffloopConfigPath()): DiffloopConfig {
  if (cachedConfig) return cachedConfig;

  const merged: Record<string, unknown> = {};

  // Tier 1: Global (~/.pi/agent/diffloop-config.json)
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8"));
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        Object.assign(merged, raw);
      }
    } catch {
      // ignore malformed global config
    }
  }

  // Tier 2: Module fallback (same path as resolveDiffloopConfigPath default)
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      mergeConfig(merged, raw);
    } catch {
      // ignore malformed module config
    }
  }

  cachedConfig = {
    enabled: parseEnabled(merged),
    diffViewMode: parseDiffViewMode(merged),
    plan: parsePlanConfig(merged),
    reviewScope: parseReviewScopeConfig(merged),
  };

  return cachedConfig;
}

export function saveEnabledToConfig(enabled: boolean, configPath = resolveDiffloopConfigPath()): void {
  let base: Record<string, unknown> = {};

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      base = { ...(parsed as Record<string, unknown>) };
    }
  } catch {
  }

  base.enabled = enabled;
  writeFileSync(configPath, `${JSON.stringify(base, null, 2)}\n`, "utf8");
}

export function isPathInReviewScope(path: string, scope: ReviewScope): boolean {
  const normalizedPath = normalizeScopePath(path);
  const extension = extname(normalizedPath).toLowerCase();

  if (scope.includeExtensions.length > 0 && !scope.includeExtensions.includes(extension)) {
    return false;
  }

  if (scope.excludeExtensions.includes(extension)) {
    return false;
  }

  if (scope.includePatterns.length > 0 && !scope.includePatterns.some((pattern) => matchesPattern(normalizedPath, pattern))) {
    return false;
  }

  if (scope.excludePatterns.some((pattern) => matchesPattern(normalizedPath, pattern))) {
    return false;
  }

  return true;
}

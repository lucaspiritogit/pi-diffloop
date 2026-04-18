import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { normalizePath } from "../lib/utils.js";

export type ReviewScope = {
  includePatterns: string[];
  excludePatterns: string[];
  includeExtensions: string[];
  excludeExtensions: string[];
};

type ReviewScopeConfigShape = Partial<{
  includePatterns: unknown;
  excludePatterns: unknown;
  includeExtensions: unknown;
  excludeExtensions: unknown;
}>;

type DiffloopConfigShape = Partial<{
  enabled: unknown;
  reviewScope: ReviewScopeConfigShape;
}> &
  ReviewScopeConfigShape;

export type DiffloopConfig = {
  enabled: boolean;
  reviewScope: ReviewScope;
};

export const DIFFLOOP_CONFIG_FILE_NAME = "diffloop-config.json";

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

export function loadDiffloopConfig(configPath = resolveDiffloopConfigPath()): DiffloopConfig {
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: parseEnabled(parsed),
      reviewScope: parseReviewScopeConfig(parsed),
    };
  } catch {
    return {
      enabled: true,
      reviewScope: parseReviewScopeConfig({}),
    };
  }
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

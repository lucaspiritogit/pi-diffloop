import { basename, extname } from "node:path";
import { normalizePath } from "./utils";

export type ReviewScope = {
  includePatterns: string[];
  excludePatterns: string[];
  includeExtensions: string[];
  excludeExtensions: string[];
};

const INCLUDE_PATTERNS_ENV = "DIFFLOOP_REVIEW_INCLUDE";
const EXCLUDE_PATTERNS_ENV = "DIFFLOOP_REVIEW_EXCLUDE";
const INCLUDE_EXTENSIONS_ENV = "DIFFLOOP_REVIEW_INCLUDE_EXTENSIONS";
const EXCLUDE_EXTENSIONS_ENV = "DIFFLOOP_REVIEW_EXCLUDE_EXTENSIONS";

function parseCsv(input?: string): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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

export function createReviewScopeFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewScope {
  const includeExtensions = parseCsv(env[INCLUDE_EXTENSIONS_ENV])
    .map(normalizeExtension)
    .filter((ext): ext is string => Boolean(ext));

  const excludeExtensions = parseCsv(env[EXCLUDE_EXTENSIONS_ENV])
    .map(normalizeExtension)
    .filter((ext): ext is string => Boolean(ext));

  return {
    includePatterns: parseCsv(env[INCLUDE_PATTERNS_ENV]).map(normalizePattern),
    excludePatterns: parseCsv(env[EXCLUDE_PATTERNS_ENV]).map(normalizePattern),
    includeExtensions,
    excludeExtensions,
  };
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

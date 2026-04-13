import { readFile } from "node:fs/promises";
import { join } from "node:path";

const NPM_LATEST_ENDPOINT = "https://registry.npmjs.org/@lpirito/pi-diffloop/latest";
const UPDATE_CHECK_TIMEOUT_MS = 3000;

let cachedUpdateCheck: Promise<string | undefined> | undefined;

export function getCachedDiffloopUpdateVersion(): Promise<string | undefined> {
  if (!cachedUpdateCheck) {
    cachedUpdateCheck = getDiffloopUpdateVersion();
  }
  return cachedUpdateCheck;
}

async function getDiffloopUpdateVersion(): Promise<string | undefined> {
  const currentVersion = await readCurrentPackageVersion();
  if (!currentVersion) return undefined;

  const latestVersion = await fetchLatestPackageVersion();
  if (!latestVersion) return undefined;

  return isVersionNewer(latestVersion, currentVersion) ? latestVersion : undefined;
}

async function readCurrentPackageVersion(): Promise<string | undefined> {
  const packageJsonPaths = [join(__dirname, "package.json"), join(__dirname, "..", "package.json")];

  for (const packageJsonPath of packageJsonPaths) {
    try {
      const rawPackageJson = await readFile(packageJsonPath, "utf8");
      const parsedPackageJson = JSON.parse(rawPackageJson) as { version?: unknown };
      if (typeof parsedPackageJson.version === "string" && parsedPackageJson.version.trim()) {
        return parsedPackageJson.version.trim();
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return undefined;
}

async function fetchLatestPackageVersion(): Promise<string | undefined> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(NPM_LATEST_ENDPOINT, {
      signal: abortController.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;

    const payload = (await response.json()) as { version?: unknown };
    if (typeof payload.version !== "string" || !payload.version.trim()) return undefined;

    return payload.version.trim();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function isVersionNewer(latestVersion: string, currentVersion: string): boolean {
  const latestParts = latestVersion.replace(/^v/, "").split("-")[0]?.split(".").map((part) => Number(part));
  const currentParts = currentVersion.replace(/^v/, "").split("-")[0]?.split(".").map((part) => Number(part));

  if (!latestParts || !currentParts) return false;
  if (latestParts.some((part) => Number.isNaN(part)) || currentParts.some((part) => Number.isNaN(part))) return false;

  const maxLength = Math.max(latestParts.length, currentParts.length);
  for (let index = 0; index < maxLength; index++) {
    const latestPart = latestParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;

    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }

  return false;
}

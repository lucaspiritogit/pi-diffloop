import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { access, constants } from "node:fs/promises";

const TAB_REPLACEMENT = "    ";

function normalizeForTerminalWidth(text: string): string {
  return text.replace(/\t/g, TAB_REPLACEMENT);
}

export function normalizePath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function pushLine(lines: string[], width: number, text: string) {
  lines.push(truncateToWidth(normalizeForTerminalWidth(text), width));
}

export function pushWrappedLine(lines: string[], width: number, text: string) {
  const wrapped = wrapTextWithAnsi(normalizeForTerminalWidth(text), Math.max(1, width));
  for (const line of wrapped) {
    lines.push(truncateToWidth(line, width, ""));
  }
}

export function pushMultiline(lines: string[], width: number, text: string) {
  for (const line of text.split("\n")) {
    pushLine(lines, width, line);
  }
}

export function pushWrappedMultiline(lines: string[], width: number, text: string) {
  for (const line of text.split("\n")) {
    pushWrappedLine(lines, width, line);
  }
}

export function pushPreview(lines: string[], width: number, text: string, prefix: string) {
  for (const line of text.split("\n")) {
    pushLine(lines, width, `${normalizeForTerminalWidth(prefix)}${normalizeForTerminalWidth(line)}`);
  }
}

export function pushWrappedPreview(lines: string[], width: number, text: string, prefix: string) {
  const normalizedPrefix = normalizeForTerminalWidth(prefix);
  const prefixWidth = visibleWidth(normalizedPrefix);
  const contentWidth = Math.max(1, width - prefixWidth);

  for (const line of text.split("\n")) {
    const wrapped = wrapTextWithAnsi(normalizeForTerminalWidth(line), contentWidth);
    if (wrapped.length === 0) {
      lines.push(truncateToWidth(normalizedPrefix, width, ""));
      continue;
    }

    for (const wrappedLine of wrapped) {
      lines.push(truncateToWidth(`${normalizedPrefix}${wrappedLine}`, width, ""));
    }
  }
}

export function replaceObject(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of Object.entries(source)) target[key] = value;
}

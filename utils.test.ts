import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizePath, pathExists, pushLine, pushWrappedLine, replaceObject } from "./utils";

describe("normalizePath", () => {
  test("strips the leading @ shorthand", () => {
    expect(normalizePath("@src/file.ts")).toBe("src/file.ts");
  });

  test("leaves regular paths unchanged", () => {
    expect(normalizePath("src/file.ts")).toBe("src/file.ts");
  });
});

describe("pathExists", () => {
  test("returns true for existing paths and false for missing ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "diffloop-test-"));
    const file = join(directory, "example.txt");

    try {
      await writeFile(file, "hello");
      expect(await pathExists(file)).toBe(true);
      expect(await pathExists(join(directory, "missing.txt"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("replaceObject", () => {
  test("mutates the target object to exactly match the source", () => {
    const target: Record<string, unknown> = { stale: true, keep: "old" };
    replaceObject(target, { keep: "new", added: 42 });

    expect(target).toEqual({ keep: "new", added: 42 });
  });
});

describe("terminal rendering helpers", () => {
  test("pushLine expands tabs before truncation", () => {
    const lines: string[] = [];
    pushLine(lines, 20, "	leading\tand\tmiddle");

    expect(lines).toHaveLength(1);
    expect(lines[0].includes("\t")).toBe(false);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(20);
  });

  test("pushWrappedLine keeps each wrapped line within width when tabs are present", () => {
    const lines: string[] = [];
    pushWrappedLine(lines, 24, "prefix\twith\ttabs and a long tail that wraps");

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.includes("\t")).toBe(false);
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    }
  });
});

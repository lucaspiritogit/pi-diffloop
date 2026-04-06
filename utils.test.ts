import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizePath, pathExists, replaceObject } from "./utils";

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

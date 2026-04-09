import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import reviewChanges, {
	buildReviewBodyLines,
	buildSteeringInstruction,
	normalizeEditInput,
	normalizeReviewModeAction,
	normalizeEditArguments,
} from "./index";

function createReviewHarness() {
	const handlers = new Map<string, Function>();
	const sentMessages: Array<{ message: string; options?: unknown }> = [];
	const sentHiddenMessages: Array<{ message: unknown; options?: unknown }> = [];

	reviewChanges({
		registerCommand() {},
		registerTool() {},
		sendUserMessage(message: string, options?: unknown) {
			sentMessages.push({ message, options });
		},
		sendMessage(message: unknown, options?: unknown) {
			sentHiddenMessages.push({ message, options });
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	} as any);

	const toolCall = handlers.get("tool_call");
	if (!toolCall) throw new Error("tool_call handler was not registered");
	const input = handlers.get("input");
	if (!input) throw new Error("input handler was not registered");
	return { toolCall, input, sentMessages, sentHiddenMessages };
}

function registerToolCallHandler() {
	return createReviewHarness().toolCall;
}

function expectBlockedWithReason(result: unknown) {
	expect(result).toEqual(expect.objectContaining({ block: true }));
}

describe("prepareEditArguments", () => {
	test("converts legacy single-edit arguments into edits array", () => {
		expect(
			normalizeEditArguments({
				path: "file.ts",
				reason: "update content",
				oldText: "before",
				newText: "after",
			}),
		).toEqual({
			path: "file.ts",
			reason: "update content",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	test("leaves normalized edits arrays untouched", () => {
		const args = {
			path: "file.ts",
			edits: [{ oldText: "before", newText: "after" }],
		};

		expect(normalizeEditArguments(args)).toBe(args);
	});

	test("sanitizes malformed edits and folds in legacy top-level edit fields", () => {
		expect(
			normalizeEditArguments({
				path: "file.ts",
				edits: [{ oldText: "missing newText" }, { oldText: "before", newText: "after" }],
				oldText: "legacy before",
				newText: "legacy after",
			}),
		).toEqual({
			path: "file.ts",
			edits: [
				{ oldText: "before", newText: "after" },
				{ oldText: "legacy before", newText: "legacy after" },
			],
		});
	});

	test("removes malformed edits before schema validation", () => {
		expect(
			normalizeEditArguments({
				path: "file.ts",
				edits: [{ oldText: "before" }, { oldText: "valid", newText: "after" }],
			}),
		).toEqual({
			path: "file.ts",
			edits: [{ oldText: "valid", newText: "after" }],
		});
	});

	test("returns unsupported payloads unchanged", () => {
		expect(normalizeEditArguments("not-an-object")).toBe("not-an-object");
		expect(normalizeEditArguments({ path: "file.ts", oldText: 123, newText: "after" })).toEqual({
			path: "file.ts",
			oldText: 123,
			newText: "after",
		});
	});
});

describe("normalizeEditInput", () => {
	test("normalizes paths, trims reasons, and filters invalid edit blocks", () => {
		const normalized = normalizeEditInput({
			path: "@src/file.ts",
			reason: "  keep this reason  ",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: 1 as never, newText: "ignored" },
				undefined as never,
			],
		});

		expect(normalized).toEqual({
			path: "src/file.ts",
			reason: "keep this reason",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	test("leaves the reason empty when none is provided", () => {
		expect(
			normalizeEditInput({
				path: "@src/file.ts",
				reason: "   ",
				edits: [{ oldText: "before", newText: "after" }],
			}),
		).toEqual({
			path: "src/file.ts",
			reason: "",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});
});

describe("normalizeReviewModeAction", () => {
	test("supports default and alias actions", () => {
		expect(normalizeReviewModeAction()).toBe("status");
		expect(normalizeReviewModeAction(" enable ")).toBe("on");
		expect(normalizeReviewModeAction("disabled")).toBe("off");
		expect(normalizeReviewModeAction("toggle")).toBe("toggle");
		expect(normalizeReviewModeAction("wat")).toBe("invalid");
	});
});

describe("buildSteeringInstruction", () => {
	test("formats developer feedback as a read-first replanning instruction", () => {
		const instruction = buildSteeringInstruction(
			"edit",
			"@src/file.ts",
			{ path: "@src/file.ts", reason: "Fix the bug", edits: [{ oldText: "a", newText: "b" }] },
			"preserve comments and change only the targeted branch",
		);

		expect(typeof instruction).toBe("string");
		expect((instruction as string).length).toBeGreaterThan(0);
	});

	test("returns undefined for empty steering input", () => {
		expect(
			buildSteeringInstruction("write", "file.ts", { path: "file.ts", reason: "Create file", content: "x" }, "   "),
		).toBeUndefined();
	});
});

describe("buildReviewBodyLines", () => {
	const theme = {
		fg: (_token: string, text: string) => text,
		bold: (text: string) => `**${text}**`,
	} as any;

	test("renders structured unified diff lines for each change block", () => {
		const lines = buildReviewBodyLines(
			{
				toolName: "edit",
				path: "src/file.ts",
				reason: "Update file",
				summary: [],
				changes: [
					{
						title: "Unified diff against current file",
						lines: [
							{ kind: "meta", text: "@@ -1,2 +1,2 @@" },
							{ kind: "context", text: " unchanged" },
							{ kind: "remove", text: "-old line" },
							{ kind: "add", text: "+new line" },
							{ kind: "warning", text: "! unmatched edit block" },
						],
					},
				],
			} as any,
			80,
			theme,
		);

		expect(lines).toEqual([
			"**Unified diff against current file**",
			"@@ -1,2 +1,2 @@",
			" unchanged",
			"-old line",
			"+new line",
			"! unmatched edit block",
			"",
		]);
	});

	test("shows an empty preview message when there are no changes", () => {
		expect(
			buildReviewBodyLines(
				{
					toolName: "write",
					path: "src/file.ts",
					reason: "Create file",
					summary: [],
					changes: [],
				} as any,
				80,
				theme,
			),
		).toEqual(["No changes to preview."]);
	});
});

describe("reviewChanges", () => {
	test("registers the command, tools, and lifecycle handlers", () => {
		const commands: Array<{ name: string; config: unknown }> = [];
		const tools: Array<any> = [];
		const handlers = new Map<string, Function>();

		reviewChanges({
			registerCommand(name: string, config: unknown) {
				commands.push({ name, config });
			},
			registerTool(config: unknown) {
				tools.push(config);
			},
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
		} as any);

		expect(commands.map((command) => command.name)).toEqual(["diffloop"]);
		expect(tools.map((tool) => tool.name)).toEqual(["edit", "write"]);
		expect(typeof tools[0].prepareArguments).toBe("function");
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("tool_call")).toBe(true);
	});

	test("blocks tool calls that omit a reason", async () => {
		const toolCall = registerToolCallHandler();
		const result = await toolCall(
			{
				toolName: "write",
				input: {
					path: "@notes.txt",
					content: "first draft",
				},
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				isIdle: () => true,
				ui: {
					custom: async () => {
						throw new Error("missing reasons should block before opening review UI");
					},
					notify() {},
				},
			} as any,
		);

		expectBlockedWithReason(result);
	});

	test("sends steering feedback from the review UI without opening a separate input dialog", async () => {
		const { toolCall, sentMessages } = createReviewHarness();
		const event = {
			toolName: "edit",
			input: {
				path: "@src/file.ts",
				reason: "Tighten the branch condition",
				edits: [{ oldText: "if (old)", newText: "if (new)" }],
			},
		};

		const result = await toolCall(event, {
			hasUI: true,
			cwd: process.cwd(),
			isIdle: () => true,
			ui: {
				custom: async () => ({ action: "steer", steering: "preserve comments and keep the fallback path unchanged" }),
				input: async () => {
					throw new Error("steering should stay inside the review UI");
				},
				notify() {},
			},
		} as any);

		expectBlockedWithReason(result);
		expect(sentMessages).toEqual([]);
	});

	test("requires a read call after steering before allowing a new edit/write", async () => {
		const { toolCall } = createReviewHarness();

		await toolCall(
			{
				toolName: "edit",
				input: {
					path: "@src/file.ts",
					reason: "Initial proposal",
					edits: [{ oldText: "old", newText: "new" }],
				},
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				isIdle: () => true,
				ui: {
					custom: async () => ({ action: "steer", steering: "refine" }),
					notify() {},
				},
			} as any,
		);

		const blocked = await toolCall(
			{
				toolName: "write",
				input: { path: "@src/file.ts", reason: "Try write", content: "next" },
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				ui: { notify() {} },
			} as any,
		);

		expectBlockedWithReason(blocked);

		const readResult = await toolCall(
			{
				toolName: "read",
				input: { path: "@src/file.ts" },
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				ui: { notify() {} },
			} as any,
		);
		expect(readResult).toBeUndefined();
	});

	test("deny aborts current execution and blocks tool calls until a new user input arrives", async () => {
		const { toolCall, input } = createReviewHarness();
		let aborted = false;

		const denied = await toolCall(
			{
				toolName: "edit",
				input: {
					path: "@src/file.ts",
					reason: "Deny this",
					edits: [{ oldText: "old", newText: "new" }],
				},
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				abort() {
					aborted = true;
				},
				isIdle: () => true,
				ui: {
					custom: async () => "deny",
					notify() {},
				},
			} as any,
		);

		expect(aborted).toBe(true);
		expectBlockedWithReason(denied);

		const blocked = await toolCall(
			{
				toolName: "write",
				input: {
					path: "@notes.txt",
					reason: "Should not run",
					content: "x",
				},
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				ui: { notify() {} },
			} as any,
		);

		expectBlockedWithReason(blocked);

		await input(
			{
				type: "input",
				text: "try again",
				source: "interactive",
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				ui: { notify() {} },
			} as any,
		);

		const afterInput = await toolCall(
			{
				toolName: "write",
				input: {
					path: "@notes.txt",
					reason: "Now allowed",
					content: "x",
				},
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				isIdle: () => true,
				ui: {
					custom: async () => "approve",
					notify() {},
				},
			} as any,
		);

		expect(afterInput).toBeUndefined();
	});

	test("blocks approve for invalid edit previews and returns read-first replanning guidance", async () => {
		const { toolCall, sentMessages } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-auto-steer-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "const value = 1;\n");

			const result = await toolCall(
				{
					toolName: "edit",
					input: {
						path: "@src/file.ts",
						reason: "Update the declaration",
						edits: [{ oldText: "const missing = 2;", newText: "const value = 2;" }],
					},
				},
				{
					hasUI: true,
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => "approve",
						notify() {},
					},
				} as any,
			);

			expectBlockedWithReason(result);
			expect(sentMessages).toEqual([]);

			const blocked = await toolCall(
				{
					toolName: "write",
					input: { path: "@src/file.ts", reason: "fallback", content: "next" },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);

			expectBlockedWithReason(blocked);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("allows approve when native edit preview is valid", async () => {
		const { toolCall, sentMessages } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-approve-valid-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "if (old) {\n\treturn old;\n}\n");

			const result = await toolCall(
				{
					toolName: "edit",
					input: {
						path: "@src/file.ts",
						reason: "Update condition",
						edits: [{ oldText: "if (old)", newText: "if (new)" }],
					},
				},
				{
					hasUI: true,
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => "approve",
						notify() {},
					},
				} as any,
			);

			expect(result).toBeUndefined();
			expect(sentMessages).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("returns edited write proposals as block reason guidance for read-first replanning", async () => {
		const { toolCall, sentHiddenMessages } = createReviewHarness();
		const customResults = ["edit"];
		const event = {
			toolName: "write",
			input: {
				path: "@notes.txt",
				reason: "Create notes",
				content: "first draft",
			},
		};

		const result = await toolCall(event, {
			hasUI: true,
			cwd: process.cwd(),
			isIdle: () => true,
			ui: {
				custom: async () => customResults.shift(),
				editor: async () => "second draft",
				notify() {},
			},
		} as any);

		expectBlockedWithReason(result);
		expect(sentHiddenMessages).toEqual([]);
	});

	test("does not require an extra read after developer edits a proposal", async () => {
		const { toolCall } = createReviewHarness();
		const customResults = ["edit", "approve"];

		const first = await toolCall(
			{
				toolName: "write",
				input: {
					path: "@notes.txt",
					reason: "Create notes",
					content: "first draft",
				},
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				isIdle: () => true,
				ui: {
					custom: async () => customResults.shift(),
					editor: async () => "second draft",
					notify() {},
				},
			} as any,
		);

		expectBlockedWithReason(first);

		const second = await toolCall(
			{
				toolName: "write",
				input: {
					path: "@notes.txt",
					reason: "Try again with updated proposal",
					content: "final draft",
				},
			},
			{
				hasUI: true,
				cwd: process.cwd(),
				isIdle: () => true,
				ui: {
					custom: async () => customResults.shift(),
					notify() {},
				},
			} as any,
		);

		expect(second).toBeUndefined();
	});

	test("returns edited edit proposals as block reason guidance for read-first replanning", async () => {
		const { toolCall, sentHiddenMessages } = createReviewHarness();
		const customResults = ["edit"];
		const directory = await mkdtemp(join(tmpdir(), "diffloop-edit-proposal-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "if (old) {\n\treturn old;\n}\n");

			const event = {
				toolName: "edit",
				input: {
					path: "@src/file.ts",
					reason: "Update the condition",
					edits: [{ oldText: "if (old)", newText: "if (new)" }],
				},
			};

			const result = await toolCall(event, {
				hasUI: true,
				cwd: directory,
				isIdle: () => true,
				ui: {
					custom: async () => customResults.shift(),
					editor: async () => "if (newer)",
					notify() {},
				},
			} as any);

			expectBlockedWithReason(result);
			expect(sentHiddenMessages).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

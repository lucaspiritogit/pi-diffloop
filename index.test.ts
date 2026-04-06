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

	reviewChanges({
		registerCommand() {},
		registerTool() {},
		sendUserMessage(message: string, options?: unknown) {
			sentMessages.push({ message, options });
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	} as any);

	const toolCall = handlers.get("tool_call");
	if (!toolCall) throw new Error("tool_call handler was not registered");
	return { toolCall, sentMessages };
}

function registerToolCallHandler() {
	return createReviewHarness().toolCall;
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
	test("formats developer feedback as a steering instruction for the agent", () => {
		expect(
			buildSteeringInstruction(
				"edit",
				"@src/file.ts",
				{ path: "@src/file.ts", reason: "Fix the bug", edits: [{ oldText: "a", newText: "b" }] },
				"preserve comments and change only the targeted branch",
			),
		).toBe(
			[
				"Do not execute the previously proposed edit for src/file.ts.",
				"Revise the edit proposal for src/file.ts based on this developer feedback: preserve comments and change only the targeted branch",
				"Previous rationale: Fix the bug",
				"Keep the review flow going by replying with an updated edit tool call for src/file.ts.",
				"Do not end with a normal text response or a completed review summary.",
				"Respond by proposing an updated tool call with a concise reason before making changes again.",
			].join("\n"),
		);
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

		expect(result).toEqual({
			block: true,
			reason:
				"Blocked write: missing required reason. Re-propose this write with a concise explanation of what it changes and why.",
		});
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

		expect(result).toEqual({
			block: true,
			reason: "Developer steered edit for src/file.ts",
		});
		expect(sentMessages).toEqual([
			{
				message: [
					"Do not execute the previously proposed edit for src/file.ts.",
					"Revise the edit proposal for src/file.ts based on this developer feedback: preserve comments and keep the fallback path unchanged",
					"Previous rationale: Tighten the branch condition",
					"Keep the review flow going by replying with an updated edit tool call for src/file.ts.",
					"Do not end with a normal text response or a completed review summary.",
					"Respond by proposing an updated tool call with a concise reason before making changes again.",
				].join("\n"),
				options: { deliverAs: "steer" },
			},
		]);
	});

	test("opens ctx.ui.editor for a write proposal even when the target file does not exist yet", async () => {
		const toolCall = registerToolCallHandler();
		const customResults = ["edit", "approve"];
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
				input: async () => {
					throw new Error("edit action should not prompt to change the reason");
				},
				editor: async () => "second draft",
				notify() {},
			},
		} as any);

		expect(result).toBeUndefined();
		expect(event.input).toEqual({
			path: "notes.txt",
			reason: "Create notes",
			content: "second draft",
		});
	});

	test("opens ctx.ui.editor on the proposed block when the developer chooses edit for an edit proposal", async () => {
		const toolCall = registerToolCallHandler();
		const customResults = ["edit", "approve"];
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
					input: async () => {
						throw new Error("edit action should not prompt to change the reason");
					},
					editor: async () => "if (newer)",
					notify() {},
				},
			} as any);

			expect(result).toBeUndefined();
			expect(event.input).toEqual({
				path: "src/file.ts",
				reason: "Update the condition",
				edits: [
					{
						oldText: "if (old)",
						newText: "if (newer)",
					},
				],
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import reviewChanges, {
	buildReviewBodyLines,
	buildSteeringInstruction,
	normalizeEditInput,
	normalizeReviewModeAction,
	normalizeEditArguments,
} from "./index";
import { resolveDiffloopConfigPath } from "./review-scope";
import { buildStructuredDiff } from "./structured-diff";

const DIFFLOOP_CONFIG_PATH = resolveDiffloopConfigPath(__dirname);

function createReviewHarness() {
	const handlers = new Map<string, Function>();
	let diffloopCommandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const sentMessages: Array<{ message: string; options?: unknown }> = [];
	const sentHiddenMessages: Array<{ message: unknown; options?: unknown }> = [];
	const appendedEntries: Array<{ customType: string; data?: unknown }> = [];

	reviewChanges({
		registerCommand(name: string, config: any) {
			if (name === "diffloop" && typeof config?.handler === "function") {
				diffloopCommandHandler = config.handler;
			}
		},
		registerTool() {},
		sendUserMessage(message: string, options?: unknown) {
			sentMessages.push({ message, options });
		},
		sendMessage(message: unknown, options?: unknown) {
			sentHiddenMessages.push({ message, options });
		},
		appendEntry(customType: string, data?: unknown) {
			appendedEntries.push({ customType, data });
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
	} as any);

	const toolCall = handlers.get("tool_call");
	if (!toolCall) throw new Error("tool_call handler was not registered");
	const toolResult = handlers.get("tool_result");
	if (!toolResult) throw new Error("tool_result handler was not registered");
	const input = handlers.get("input");
	if (!input) throw new Error("input handler was not registered");
	if (!diffloopCommandHandler) throw new Error("diffloop command handler was not registered");
	return { toolCall, toolResult, input, diffloopCommandHandler, sentMessages, sentHiddenMessages, appendedEntries };
}

function registerToolCallHandler() {
	return createReviewHarness().toolCall;
}

function expectBlockedWithReason(result: unknown) {
	expect(result).toEqual(expect.objectContaining({ block: true }));
}

async function readDiffloopConfigSnapshot(): Promise<string | undefined> {
	try {
		return await readFile(DIFFLOOP_CONFIG_PATH, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

async function restoreDiffloopConfig(snapshot: string | undefined): Promise<void> {
	if (snapshot === undefined) {
		await rm(DIFFLOOP_CONFIG_PATH, { force: true });
		return;
	}

	await writeFile(DIFFLOOP_CONFIG_PATH, snapshot, "utf8");
}

function createCommandCtx() {
	return {
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			theme: {
				fg: (_token: string, text: string) => text,
			},
		},
	} as any;
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
			"preserve comments and change only the targeted branch",
		);

		expect(typeof instruction).toBe("string");
		expect((instruction as string).length).toBeGreaterThan(0);
	});

	test("returns undefined for empty steering input", () => {
		expect(buildSteeringInstruction("write", "file.ts", "   ")).toBeUndefined();
	});
});

describe("buildReviewBodyLines", () => {
	const theme = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
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

	test("renders structured diffs in side-by-side mode by default", () => {
		const lines = buildReviewBodyLines(
			{
				toolName: "edit",
				path: "src/file.ts",
				reason: "Update file",
				summary: [],
				changes: [
					{
						title: "Structured diff",
						lines: [{ kind: "warning", text: "! native preview warning" }],
						diffModel: buildStructuredDiff("alpha\nbeta\n", "alpha\nBETA\n"),
					},
				],
			} as any,
			36,
			theme,
		);

		expect(lines.some((line) => line.includes("Original"))).toBe(true);
		expect(lines.some((line) => line.includes("Updated"))).toBe(true);
		expect(lines.some((line) => line.includes("! native preview warning"))).toBe(true);
	});

	test("renders inline mode when explicitly requested", () => {
		const lines = buildReviewBodyLines(
			{
				toolName: "edit",
				path: "src/file.ts",
				reason: "Update file",
				summary: [],
				changes: [
					{
						title: "Structured diff",
						lines: [],
						diffModel: buildStructuredDiff("alpha\nbeta\n", "alpha\nBETA\n"),
					},
				],
			} as any,
			36,
			theme,
			"inline",
		);

		expect(lines.some((line) => line.includes("Original"))).toBe(false);
		expect(lines.some((line) => line.includes("beta"))).toBe(true);
		expect(lines.some((line) => line.includes("BETA"))).toBe(true);
	});

	test("applies syntax token coloring for structured diffs when language is detected", () => {
		const lines = buildReviewBodyLines(
			{
				toolName: "edit",
				path: "src/example.ts",
				reason: "Update code",
				summary: [],
				changes: [
					{
						title: "Structured diff",
						lines: [],
						diffModel: buildStructuredDiff("const value = 1;\n", "const value = 2;\n"),
					},
				],
			} as any,
			80,
			theme,
			"inline",
		);

		expect(lines.some((line) => line.includes("\x1b[38;5;"))).toBe(true);
	});
});

describe("reviewChanges", () => {
	test("registers the command and lifecycle handlers", () => {
		const commands: Array<{ name: string; config: unknown }> = [];
		const handlers = new Map<string, Function>();

		reviewChanges({
			registerCommand(name: string, config: unknown) {
				commands.push({ name, config });
			},
			registerTool() {},
			on(event: string, handler: Function) {
				handlers.set(event, handler);
			},
		} as any);

		expect(commands.map((command) => command.name)).toEqual(["diffloop"]);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("tool_call")).toBe(true);
	});

	test("loads disabled mode from diffloop-config.json and bypasses review", async () => {
		const configSnapshot = await readDiffloopConfigSnapshot();

		try {
			await writeFile(
				DIFFLOOP_CONFIG_PATH,
				`${JSON.stringify(
					{
						enabled: false,
					},
					null,
					2,
				)}\n`,
				"utf8",
			);

			const { toolCall } = createReviewHarness();
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
							throw new Error("review UI should not open while diffloop is disabled");
						},
						notify() {},
					},
				} as any,
			);

			expect(result).toBeUndefined();
		} finally {
			await restoreDiffloopConfig(configSnapshot);
		}
	});

	test("persists /diffloop off and /diffloop on across new extension instances", async () => {
		const configSnapshot = await readDiffloopConfigSnapshot();

		try {
			await writeFile(
				DIFFLOOP_CONFIG_PATH,
				`${JSON.stringify(
					{
						enabled: true,
					},
					null,
					2,
				)}\n`,
				"utf8",
			);

			const first = createReviewHarness();
			await first.diffloopCommandHandler("off", createCommandCtx());

			const second = createReviewHarness();
			const disabledResult = await second.toolCall(
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
							throw new Error("review UI should not open while diffloop is disabled");
						},
						notify() {},
					},
				} as any,
			);
			expect(disabledResult).toBeUndefined();

			await second.diffloopCommandHandler("on", createCommandCtx());

			const third = createReviewHarness();
			const enabledResult = await third.toolCall(
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
							throw new Error("review should block before opening UI when reason is missing");
						},
						notify() {},
					},
				} as any,
			);

			expectBlockedWithReason(enabledResult);
			expect((enabledResult as any).reason).toContain("set_change_reason");
		} finally {
			await restoreDiffloopConfig(configSnapshot);
		}
	});

	test("appends diffloop audit entries for blocked previews and approved decisions", async () => {
		const { toolCall, appendedEntries } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-audit-entries-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });

			const blocked = await toolCall(
				{
					toolName: "edit",
					input: {
						path: "@src/new-file.ts",
						reason: "Create initial content",
						edits: [{ oldText: "placeholder", newText: "export const value = 1;\n" }],
					},
				},
				{
					hasUI: true,
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => {
							throw new Error("missing target should block before opening review UI");
						},
						notify() {},
					},
				} as any,
			);
			expectBlockedWithReason(blocked);

			const approved = await toolCall(
				{
					toolName: "write",
					input: {
						path: "@src/new-file.ts",
						reason: "Write initial content",
						content: "export const value = 1;\n",
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
			expect(approved).toBeUndefined();

			const audits = appendedEntries
				.filter((entry) => entry.customType === "diffloop-audit")
				.map((entry) => entry.data as { kind?: string; action?: string });
			expect(audits.some((entry) => entry.kind === "blocked")).toBe(true);
			expect(audits.some((entry) => entry.kind === "decision" && entry.action === "approve")).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("allows write proposals with inline reason and strips non-native fields", async () => {
		const toolCall = registerToolCallHandler();
		const event = {
			toolName: "write",
			input: {
				path: "@notes.txt",
				content: "first draft",
				reason: "Create notes",
			},
		};

		const result = await toolCall(
			event,
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

		expect(result).toBeUndefined();
		expect(event.input).toEqual({
			path: "notes.txt",
			content: "first draft",
		});
	});

	test("blocks in-scope writes when no reason is provided", async () => {
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
						throw new Error("review UI should not open when reason is missing");
					},
					notify() {},
				},
			} as any,
		);

		expectBlockedWithReason(result);
		expect((result as any).reason).toContain("set_change_reason");
	});

	test("uses set_change_reason for the next write proposal", async () => {
		const toolCall = registerToolCallHandler();
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			isIdle: () => true,
			ui: {
				custom: async () => "approve",
				notify() {},
			},
		} as any;

		const reasonResult = await toolCall(
			{
				toolName: "set_change_reason",
				input: { reason: "Create notes" },
			},
			ctx,
		);
		expect(reasonResult).toBeUndefined();

		const writeEvent = {
			toolName: "write",
			input: {
				path: "@notes.txt",
				content: "first draft",
			},
		};
		const writeResult = await toolCall(writeEvent, ctx);

		expect(writeResult).toBeUndefined();
		expect(writeEvent.input).toEqual({
			path: "notes.txt",
			content: "first draft",
		});
	});

	test("normalizes legacy edit payloads and strips non-native fields before execution", async () => {
		const toolCall = registerToolCallHandler();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-edit-normalize-"));
		const event = {
			toolName: "edit",
			input: {
				path: "@src/file.ts",
				oldText: "before",
				newText: "after",
				reason: "Update text",
			},
		};

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "before");

			const result = await toolCall(
				event,
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
			expect(event.input).toEqual({
				path: "src/file.ts",
				edits: [{ oldText: "before", newText: "after" }],
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("skips review for out-of-scope files via diffloop-config.json include patterns", async () => {
		const configSnapshot = await readDiffloopConfigSnapshot();

		try {
			await writeFile(
				DIFFLOOP_CONFIG_PATH,
				`${JSON.stringify(
					{
						reviewScope: {
							includePatterns: ["*.ts"],
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);

			const toolCall = registerToolCallHandler();
			const outOfScope = await toolCall(
				{
					toolName: "write",
					input: {
						path: "@notes.lock",
						content: "first draft",
					},
				},
				{
					hasUI: true,
					cwd: process.cwd(),
					isIdle: () => true,
					ui: {
						custom: async () => {
							throw new Error("out-of-scope files should bypass review UI");
						},
						notify() {},
					},
				} as any,
			);
			expect(outOfScope).toBeUndefined();

			const inScope = await toolCall(
				{
					toolName: "write",
					input: {
						path: "@src/file.ts",
						content: "first draft",
						reason: "Create first draft",
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
			expect(inScope).toBeUndefined();
		} finally {
			await restoreDiffloopConfig(configSnapshot);
		}
	});

	test("sends steering feedback once via deliverAs=steer without opening a separate input dialog", async () => {
		const { toolCall, sentMessages } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-steer-review-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "if (old) {\n  return 1;\n}\n");

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
				cwd: directory,
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
			expect(sentMessages).toHaveLength(1);
			expect(sentMessages[0]?.message).toContain("Revise edit for src/file.ts.");
			expect(sentMessages[0]?.options).toEqual(expect.objectContaining({ deliverAs: "steer" }));
			expect((result as any).reason).toBe("");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("does not require a read call after steering before allowing a new edit/write", async () => {
		const { toolCall } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-steer-read-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "old\n");

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
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => ({ action: "steer", steering: "refine" }),
						notify() {},
					},
				} as any,
			);

			const result = await toolCall(
				{
					toolName: "write",
					input: { path: "@src/file.ts", reason: "Try write", content: "next" },
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
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("deny aborts current execution and blocks tool calls until a new user input arrives", async () => {
		const { toolCall, input } = createReviewHarness();
		let aborted = false;
		const directory = await mkdtemp(join(tmpdir(), "diffloop-deny-review-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "old\n");

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
					cwd: directory,
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
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);

			expectBlockedWithReason(blocked);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}

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

	test("enforces read-first retry after edit/write execution errors", async () => {
		const { toolCall, toolResult } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-tool-error-retry-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "const value = 1;\n");

			const recovered = await toolResult(
				{
					toolName: "edit",
					toolCallId: "edit-error-1",
					input: {
						path: "@src/file.ts",
						reason: "Update declaration",
						edits: [{ oldText: "const missing = 2;", newText: "const value = 2;" }],
					},
					content: [{ type: "text", text: "native edit failed" }],
					details: undefined,
					isError: true,
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);

			const recoveredContent = ((recovered as any)?.content ?? []) as Array<{ text?: string }>;
			expect(recoveredContent[recoveredContent.length - 1]?.text).toContain("read src/file.ts");

			const blocked = await toolCall(
				{
					toolName: "write",
					input: { path: "@src/file.ts", reason: "retry", content: "const value = 2;\n" },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: {
						custom: async () => {
							throw new Error("read-first retry should block before opening review UI");
						},
						notify() {},
					},
				} as any,
			);
				expectBlockedWithReason(blocked);
				expect((blocked as any).reason).toContain("read src/file.ts first");

				const unrelatedPathAllowed = await toolCall(
					{
						toolName: "write",
						input: { path: "@src/other.ts", reason: "unrelated", content: "export const other = 1;\n" },
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
				expect(unrelatedPathAllowed).toBeUndefined();

				const readAttempt = await toolCall(
					{
					toolName: "read",
					toolCallId: "read-after-error",
					input: { path: "@src/file.ts" },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);
			expect(readAttempt).toBeUndefined();

			const allowedAfterRead = await toolCall(
				{
					toolName: "write",
					input: { path: "@src/file.ts", reason: "retry", content: "const value = 2;\n" },
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
			expect(allowedAfterRead).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("blocks invalid edit previews before opening review and returns read-first replanning guidance", async () => {
		const { toolCall, sentMessages } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-auto-steer-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });
			await writeFile(join(directory, "src/file.ts"), "const value = 1;\nconst value = 2;\n");

			const result = await toolCall(
				{
					toolName: "edit",
					input: {
						path: "@src/file.ts",
						reason: "Update the declaration",
						edits: [{ oldText: "const value = ", newText: "const value = 3" }],
					},
				},
				{
					hasUI: true,
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => {
							throw new Error("invalid previews should block before opening review UI");
						},
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

	test("blocks missing-target edits before opening review and asks for a write proposal", async () => {
		const { toolCall } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-missing-target-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });

			const first = await toolCall(
				{
					toolName: "edit",
					input: {
						path: "@src/new-file.ts",
						reason: "Create the initial implementation",
						edits: [{ oldText: "placeholder", newText: "export const value = 1;\n" }],
					},
				},
				{
					hasUI: true,
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => {
							throw new Error("missing-target previews should block before opening review UI");
						},
						notify() {},
					},
				} as any,
			);

			expectBlockedWithReason(first);
			expect((first as any).reason).toContain("Target file is missing");
			expect((first as any).reason).toContain("Submit one write proposal");
			expect((first as any).reason).not.toContain("candidate-files/");

			const allowedWrite = await toolCall(
				{
					toolName: "write",
					input: { path: "@src/new-file.ts", reason: "Now write", content: "export const value = 2;" },
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
			expect(allowedWrite).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("repeats blocked guidance for repeated missing-target edit proposals", async () => {
		const { toolCall } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-missing-target-repeat-"));

		try {
			await mkdir(join(directory, "src"), { recursive: true });

			const input = {
				path: "@src/new-file.ts",
				reason: "Create the initial implementation",
				edits: [{ oldText: "placeholder", newText: "export const value = 1;\n" }],
			};

			const first = await toolCall(
				{
					toolName: "edit",
					input,
				},
				{
					hasUI: true,
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => {
							throw new Error("missing-target previews should block before opening review UI");
						},
						notify() {},
					},
				} as any,
			);
			expectBlockedWithReason(first);
			expect((first as any).reason).toContain("Target file is missing");

			const second = await toolCall(
				{
					toolName: "edit",
					input,
				},
				{
					hasUI: true,
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => {
							throw new Error("missing-target previews should block before opening review UI");
						},
						notify() {},
					},
				} as any,
			);
			expectBlockedWithReason(second);
			expect((second as any).reason).toContain("Target file is missing");
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

	test("re-reviews edited write proposals before final approval", async () => {
		const { toolCall, sentHiddenMessages } = createReviewHarness();
		const customResults = ["edit", "approve"];
		const directory = await mkdtemp(join(tmpdir(), "diffloop-edited-write-missing-target-"));

		try {
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
				cwd: directory,
				isIdle: () => true,
				ui: {
					custom: async () => customResults.shift() ?? "approve",
					editor: async () => "second draft",
					notify() {},
				},
			} as any);

			expect(result).toBeUndefined();
			expect(event.input).toEqual({
				path: "notes.txt",
				content: "second draft",
			});
			expect(sentHiddenMessages).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("applies approved edited write content on tool_result even if original write payload ran", async () => {
		const { toolCall, toolResult } = createReviewHarness();
		const customResults = ["edit", "approve"];
		const directory = await mkdtemp(join(tmpdir(), "diffloop-write-override-"));

		try {
			const event = {
				toolName: "write",
				toolCallId: "write-override-1",
				input: {
					path: "@notes.txt",
					reason: "Create notes",
					content: "first draft",
				},
			};

			const callResult = await toolCall(event, {
				hasUI: true,
				cwd: directory,
				isIdle: () => true,
				ui: {
					custom: async () => customResults.shift() ?? "approve",
					editor: async () => "second draft",
					notify() {},
				},
			} as any);
			expect(callResult).toBeUndefined();

			await writeFile(join(directory, "notes.txt"), "first draft", "utf8");
			const result = await toolResult(
				{
					toolName: "write",
					toolCallId: "write-override-1",
					input: { path: "@notes.txt" },
					content: [{ type: "text", text: "write ok" }],
					details: {},
					isError: false,
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);
			expect(result).toBeUndefined();
			expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("second draft");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("applies approved edited write content on tool_result when toolCallId is missing", async () => {
		const { toolCall, toolResult } = createReviewHarness();
		const customResults = ["edit", "approve"];
		const directory = await mkdtemp(join(tmpdir(), "diffloop-write-override-no-id-"));

		try {
			const event = {
				toolName: "write",
				input: {
					path: "@notes.txt",
					reason: "Create notes",
					content: "first draft",
				},
			};

			const callResult = await toolCall(event, {
				hasUI: true,
				cwd: directory,
				isIdle: () => true,
				ui: {
					custom: async () => customResults.shift() ?? "approve",
					editor: async () => "second draft",
					notify() {},
				},
			} as any);
			expect(callResult).toBeUndefined();

			await writeFile(join(directory, "notes.txt"), "first draft", "utf8");
			const result = await toolResult(
				{
					toolName: "write",
					input: { path: "@notes.txt" },
					content: [{ type: "text", text: "write ok" }],
					details: {},
					isError: false,
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);
			expect(result).toBeUndefined();
			expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("second draft");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("re-reviews edited edit proposals before final approval", async () => {
		const { toolCall, sentHiddenMessages } = createReviewHarness();
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
					custom: async () => customResults.shift() ?? "approve",
					editor: async () => "if (newer)",
					notify() {},
				},
			} as any);

			expect(result).toBeUndefined();
			expect(event.input).toEqual({
				path: "src/file.ts",
				edits: [{ oldText: "if (old)", newText: "if (newer)" }],
			});
			expect(sentHiddenMessages).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

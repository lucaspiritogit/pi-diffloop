import { describe, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import reviewChanges, {
	buildReviewBodyLines,
	buildSteeringInstruction,
	clearCandidateFilesDirectory,
	normalizeEditInput,
	normalizeReviewModeAction,
	normalizeEditArguments,
} from "./index";

const CANDIDATE_FILES_DIR = join(tmpdir(), "diffloop", "candidate-files");

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
	const toolResult = handlers.get("tool_result");
	if (!toolResult) throw new Error("tool_result handler was not registered");
	const input = handlers.get("input");
	if (!input) throw new Error("input handler was not registered");
	return { toolCall, toolResult, input, sentMessages, sentHiddenMessages };
}

function registerToolCallHandler() {
	return createReviewHarness().toolCall;
}

function expectBlockedWithReason(result: unknown) {
	expect(result).toEqual(expect.objectContaining({ block: true }));
}

function extractEditedProposalPath(reason: string): string | undefined {
	const match = reason.match(/\S*candidate-files\/[^/\s]+\/[^\s]+/);
	if (!match) return undefined;
	return match[0].replace(/[.,]$/, "");
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function directoryHasEntries(path: string): Promise<boolean> {
	try {
		const entries = await readdir(path);
		return entries.length > 0;
	} catch {
		return false;
	}
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

describe("clearCandidateFilesDirectory", () => {
	test("removes the candidate directory recursively", async () => {
		const directory = await mkdtemp(join(tmpdir(), "diffloop-candidate-cleanup-"));
		await mkdir(join(directory, "nested"), { recursive: true });
		await writeFile(join(directory, "nested/candidate.ts"), "export const value = 1;\n");

		expect(await fileExists(directory)).toBe(true);
		await clearCandidateFilesDirectory(directory);
		expect(await fileExists(directory)).toBe(false);
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

	test("skips review for out-of-scope files via include patterns", async () => {
		const previousInclude = process.env.DIFFLOOP_REVIEW_INCLUDE;
		process.env.DIFFLOOP_REVIEW_INCLUDE = "*.ts";

		try {
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
					},
				},
				{
					hasUI: true,
					cwd: process.cwd(),
					isIdle: () => true,
					ui: {
						custom: async () => {
							throw new Error("in-scope missing reason should block before review UI");
						},
						notify() {},
					},
				} as any,
			);
			expectBlockedWithReason(inScope);
		} finally {
			if (previousInclude === undefined) {
				delete process.env.DIFFLOOP_REVIEW_INCLUDE;
			} else {
				process.env.DIFFLOOP_REVIEW_INCLUDE = previousInclude;
			}
		}
	});

	test("creates a candidate file when reviewing write proposals", async () => {
		const { toolCall } = createReviewHarness();
		const directory = await mkdtemp(join(tmpdir(), "diffloop-write-candidate-"));

		try {
			await clearCandidateFilesDirectory(CANDIDATE_FILES_DIR);

			const result = await toolCall(
				{
					toolName: "write",
					input: {
						path: "@notes.txt",
						reason: "Create notes file",
						content: "first draft",
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
			expect(await directoryHasEntries(CANDIDATE_FILES_DIR)).toBe(true);
		} finally {
			await clearCandidateFilesDirectory(CANDIDATE_FILES_DIR);
			await rm(directory, { recursive: true, force: true });
		}
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

	test("does not require a read call after steering before allowing a new edit/write", async () => {
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

		const result = await toolCall(
			{
				toolName: "write",
				input: { path: "@src/file.ts", reason: "Try write", content: "next" },
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

		expect(result).toBeUndefined();
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

	test("blocks approve for edits on missing files and routes replanning through candidate files", async () => {
		const { toolCall, toolResult } = createReviewHarness();
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
						custom: async () => "approve",
						notify() {},
					},
				} as any,
			);

			expectBlockedWithReason(first);
			expect((first as any).reason).toContain("candidate-files/");
			const candidatePath = extractEditedProposalPath((first as any).reason as string);
			expect(candidatePath?.endsWith(".ts")).toBe(true);
			if (!candidatePath) {
				throw new Error("Expected a candidate path for missing-target replanning");
			}
			expect(await fileExists(candidatePath)).toBe(true);

			const blockedBeforeReads = await toolCall(
				{
					toolName: "write",
					input: { path: "@src/new-file.ts", reason: "Try write", content: "export const value = 2;" },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);

			expectBlockedWithReason(blockedBeforeReads);

			const readCandidate = await toolCall(
				{
					toolName: "read",
					toolCallId: "read-missing-candidate",
					input: { path: candidatePath },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);
			expect(readCandidate).toBeUndefined();

			const readCandidateResult = await toolResult(
				{
					toolName: "read",
					toolCallId: "read-missing-candidate",
					input: { path: candidatePath },
					content: "export const value = 1;",
					details: {},
					isError: false,
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);
			expect(readCandidateResult).toBeUndefined();
			expect(await fileExists(candidatePath)).toBe(false);

			const allowedAfterReads = await toolCall(
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

			expect(allowedAfterReads).toBeUndefined();
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

	test("blocks edited write proposals and requests read-first reassessment", async () => {
		const { toolCall, sentHiddenMessages } = createReviewHarness();
		const customResults = ["edit"];
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
					custom: async () => customResults.shift() ?? "edit",
					editor: async () => "second draft",
					notify() {},
				},
			} as any);

			expectBlockedWithReason(result);
			expect((result as any).reason).not.toContain("Read notes.txt and");
			expect((result as any).reason).toContain("candidate-files/");
			const candidatePath = extractEditedProposalPath((result as any).reason as string);
			expect(candidatePath?.endsWith(".json")).toBe(false);
			expect(candidatePath?.endsWith(".txt")).toBe(true);
			expect(sentHiddenMessages).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("requires reading both target and candidate after developer edits when target already exists", async () => {
		const { toolCall, toolResult } = createReviewHarness();
		const customResults = ["edit", "approve"];
		const directory = await mkdtemp(join(tmpdir(), "diffloop-edited-write-existing-target-"));

		try {
			await writeFile(join(directory, "notes.txt"), "existing\n");

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
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => customResults.shift() ?? "edit",
						editor: async () => "second draft",
						notify() {},
					},
				} as any,
			);
			expectBlockedWithReason(first);
			const firstReason = (first as any).reason as string;
			expect(firstReason).toContain("Read notes.txt and");
			const editedProposalPath = extractEditedProposalPath(firstReason);
			expect(editedProposalPath).toBeDefined();
			if (!editedProposalPath) {
				throw new Error("Expected an edited proposal path in steering instruction");
			}

			const blocked = await toolCall(
				{
					toolName: "write",
					input: { path: "@notes.txt", reason: "Try write", content: "next" },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);

			expectBlockedWithReason(blocked);

			const readResult = await toolCall(
				{
					toolName: "read",
					toolCallId: "read-target",
					input: { path: "@notes.txt" },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);
			expect(readResult).toBeUndefined();

			const stillBlockedAfterTargetRead = await toolCall(
				{
					toolName: "write",
					input: { path: "@notes.txt", reason: "Try write", content: "next" },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);

			expectBlockedWithReason(stillBlockedAfterTargetRead);

			const readEditedProposal = await toolCall(
				{
					toolName: "read",
					toolCallId: "read-edited-proposal",
					input: { path: editedProposalPath },
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);
			expect(readEditedProposal).toBeUndefined();
			expect(await fileExists(editedProposalPath)).toBe(true);

			const readEditedProposalResult = await toolResult(
				{
					toolName: "read",
					toolCallId: "read-edited-proposal",
					input: { path: editedProposalPath },
					content: "{}",
					details: {},
					isError: false,
				},
				{
					hasUI: true,
					cwd: directory,
					ui: { notify() {} },
				} as any,
			);
			expect(readEditedProposalResult).toBeUndefined();
			expect(await fileExists(editedProposalPath)).toBe(false);

			const allowedAfterRead = await toolCall(
				{
					toolName: "write",
					input: { path: "@notes.txt", reason: "Try write", content: "next" },
				},
				{
					hasUI: true,
					cwd: directory,
					isIdle: () => true,
					ui: {
						custom: async () => customResults.shift() ?? "approve",
						notify() {},
					},
				} as any,
			);

			expect(allowedAfterRead).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("blocks edited edit proposals and requests read-first reassessment", async () => {
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
					custom: async () => customResults.shift() ?? "edit",
					editor: async () => "if (newer)",
					notify() {},
				},
			} as any);

			expectBlockedWithReason(result);
			expect((result as any).reason).toContain("Read src/file.ts");
			expect((result as any).reason).toContain("candidate-files/");
			const candidatePath = extractEditedProposalPath((result as any).reason as string);
			expect(candidatePath?.endsWith(".json")).toBe(false);
			expect(candidatePath?.endsWith(".ts")).toBe(true);
			expect(sentHiddenMessages).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { getNativeEditBlockStatuses } from "../diff-preview.js";
import type { EditBlock, EditInput, NativeEditBlockStatus, WriteInput } from "../review-types.js";
import { normalizeEditInput } from "../tools/edit-write-input.js";
import { normalizePath } from "../utils.js";

type ExternalEditorResult = {
  exitCode: number;
  errorMessage?: string;
};

async function openProposalInEditor(
  ctx: ExtensionContext,
  path: string,
  initialContent: string,
  fallbackTitle: string,
): Promise<string | undefined> {
  const editorCmd = process.env.EDITOR || process.env.VISUAL;
  if (!editorCmd) {
    return ctx.ui.editor(fallbackTitle, initialContent);
  }

  const fileExtension = extname(path) || ".txt";
  const tempDir = await mkdtemp(join(tmpdir(), "diffloop-editor-"));
  const draftPath = join(tempDir, `proposal${fileExtension}`);

  try {
    try {
      await chmod(tempDir, 0o700);
    } catch {
    }

    await writeFile(draftPath, initialContent, { encoding: "utf8", mode: 0o600 });

    const shell = process.env.SHELL || "/bin/sh";
    const escapedPath = draftPath.replace(/(["\\`$])/g, "\\$1");
    const command = `${editorCmd} "${escapedPath}"`;

    const result = await ctx.ui.custom<ExternalEditorResult>(
      (tui, _theme, _kb, done) => {
        tui.stop();
        process.stdout.write("\x1b[2J\x1b[H");

        try {
          const run = spawnSync(shell, ["-c", command], {
            stdio: "inherit",
            env: process.env,
          });

          done({
            exitCode: run.status ?? 1,
            errorMessage: run.error instanceof Error ? run.error.message : undefined,
          });
        } catch (error) {
          done({
            exitCode: 1,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        } finally {
          tui.start();
          tui.requestRender(true);
        }

        return { render: () => [], invalidate: () => {} };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "bottom-center",
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
      },
    );

    if (result.exitCode !== 0) {
      ctx.ui.notify(
        result.errorMessage
          ? `External editor failed: ${result.errorMessage}`
          : `External editor exited with code ${result.exitCode}.`,
        "warning",
      );
      return undefined;
    }

    return (await readFile(draftPath, "utf8")).replace(/\n$/, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function describeEditBlockOption(edit: EditBlock, index: number, status?: NativeEditBlockStatus): string {
  const preview = summarizeCodeSnippet(edit.newText || edit.oldText);
  const suffix = !status
    ? ""
    : status.ok
      ? ""
      : status.kind === "notFound"
        ? " (not found)"
        : status.kind === "notUnique"
          ? " (not unique)"
          : " (invalid)";
  return `Block ${index + 1}${suffix}: ${preview}`;
}

function summarizeCodeSnippet(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim() || "(empty)";
  return singleLine;
}

export async function editProposal(
  ctx: ExtensionContext,
  toolName: "write" | "edit",
  input: WriteInput | EditInput,
): Promise<WriteInput | EditInput | undefined> {
  if (toolName === "write") {
    const writeInput = input as WriteInput;

    const content = await openProposalInEditor(
      ctx,
      normalizePath(writeInput.path),
      writeInput.content,
      `Edit proposed content for ${normalizePath(writeInput.path)}`,
    );
    if (content === undefined) return undefined;

    return {
      path: normalizePath(writeInput.path),
      reason: writeInput.reason.trim(),
      content,
    };
  }

  const current = normalizeEditInput(input as EditInput);

  if (current.edits.length === 1) {
    const edit = current.edits[0]!;
    const content = await openProposalInEditor(ctx, current.path, edit.newText, `Edit proposed block for ${current.path}`);
    if (content === undefined) return undefined;

    return normalizeEditInput({
      path: current.path,
      reason: current.reason,
      edits: [{ oldText: edit.oldText, newText: content }],
    });
  }

  const absolutePath = resolve(ctx.cwd, current.path);
  let existingContent: string | undefined;
  try {
    existingContent = await readFile(absolutePath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const blockStatuses =
    existingContent !== undefined ? await getNativeEditBlockStatuses(ctx.cwd, current.path, current.edits) : undefined;
  const options = current.edits.map((edit: EditBlock, index: number) =>
    describeEditBlockOption(edit, index, blockStatuses?.[index]),
  );
  const choice = await ctx.ui.select(`Choose a proposed block to edit for ${current.path}`, options);
  if (choice === undefined) return undefined;

  const selectedIndex = options.indexOf(choice);
  if (selectedIndex < 0) return undefined;

  const selectedEdit = current.edits[selectedIndex]!;
  const content = await openProposalInEditor(
    ctx,
    current.path,
    selectedEdit.newText,
    `Edit proposed block ${selectedIndex + 1} for ${current.path}`,
  );
  if (content === undefined) return undefined;

  return normalizeEditInput({
    path: current.path,
    reason: current.reason,
    edits: current.edits.map((edit: EditBlock, index: number) =>
      index === selectedIndex ? { oldText: edit.oldText, newText: content } : edit,
    ),
  });
}

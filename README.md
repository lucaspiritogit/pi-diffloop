# diffloop

`diffloop` is a Pi extension that slows down the agentic coding workflow on purpose by presenting each code change to the developer, with a compact task plan attached to it.

![diffloop review UI](./assets/image.png)

## What it does

This extension intercepts Pi `edit` and `write` tool calls and replaces the default fire-and-forget flow with an interactive review step.

For each proposed file change, diffloop:

- shows a preview before execution
- shows the agent's current goal, step, and planned files
- lets you:
  - **approve** the change
  - **steer** the change with an inline prompt
  - **edit** the proposal before execution
  - **deny** the change

## Installation

```sh
pi install npm:@lpirito/pi-diffloop
```

## Why does diffloop exist?

When working with coding agents, I kept running into two extremes:

- I write a long markdown file full of rules, conventions, and constraints, hoping the agent will stay aligned.
- I prompt for a bugfix or feature and wait for the result, only to receive a large batch of changes all at once.

Both approaches can work, but they often come with the same problem: **context loss**.

The agent may go further than expected, touch more files than intended, or make reasonable local decisions that drift away from what you had in mind. By the time it returns, you are no longer reviewing a small decision, you are reconstructing a chain of reasoning that is not your own.

That is the problem diffloop is "meant" to solve.

It intentionally slows the workflow down so you can stay close to the agents decisions, review changes as they are proposed, and understand both **what** is changing and **why** before the change is applied.

### A note on usage

diffloop is still an experiment for me, and Im grateful to Pi for providing such solid tools to explore ideas like this.

That said, constant review can become its own kind of fatigue. If every step requires approval, there is always the risk of falling into the habit of pressing "Accept" without really reviewing the change.

Im still exploring whether this kind of intentional slowness has a real place in agentic coding workflows, especially for developers who want to stay close to the code without losing context.

Ideas, feedback, and criticism are all welcome 😁

## Review flow

When the agent proposes an `edit` or `write`:

1. diffloop intercepts the tool call
2. it builds a preview of the change
3. it opens a review UI
4. you choose one of the available actions

## Configuration (optional)

diffloop supports configuration via a global config file and a module-level fallback.

### Config locations

| Location   | Path                                                 | Purpose                            |
| ---------- | ---------------------------------------------------- | ---------------------------------- |
| **Global** | `~/.pi/agent/extensions/diffloop-config.json`        | User-wide defaults (applied first) |
| **Module** | `diffloop-config.json` next to the installed package | Overrides global config            |

Global config is loaded first, then module config is shallow-merged on top (module wins for any key it contains). The `reviewScope` key is replaced entirely if both files define it. If neither file exists, diffloop uses its built-in defaults.

### Config keys

| Key            | Type                    | Default   | Description                             |
| -------------- | ----------------------- | --------- | --------------------------------------- |
| `enabled`      | `boolean`               | `true`    | Whether review is enabled               |
| `diffViewMode` | `"split"` or `"inline"` | `"split"` | How the diff preview is rendered        |
| `reviewScope`  | `object`                | `{}`      | Scope review to specific files/patterns |

### `reviewScope` shape

When present, `reviewScope` controls which files are reviewed:

```json
{
  "enabled": true,
  "diffViewMode": "inline",
  "reviewScope": {
    "includePatterns": ["*.ts", "*.tsx"],
    "excludePatterns": ["**/*.snap"],
    "includeExtensions": [".ts", ".tsx"],
    "excludeExtensions": [".lock"]
  }
}
```

Out-of-scope paths bypass diffloop review and run through Pi's normal tool execution.

## Agent plan behavior

This extension does **not** re-register the `edit` and `write` tools.

Instead, it registers a small helper tool called `set_change_plan` and prompts the agent to call it before the first `edit`/`write` proposal for a task, then refresh it whenever the approach changes.

The review UI shows the latest plan snapshot above every diff:

- **Goal**: the overall task objective
- **Now**: the current step
- **File**: current file position in the planned review order
- **Files to review**: planned files after the current one

`plannedFiles` should be ordered from lower-level dependencies toward higher-level callers or UI when the task has a clear dependency chain.

If the agent proposes a change to a file that is not listed in `plannedFiles`, diffloop shows a warning but does not block the review.

## Slash commands

```text
/diffloop off
/diffloop on
/diffloop toggle
/diffloop status
```

## Development

```bash
npm install
npm run build
npm run typecheck
```

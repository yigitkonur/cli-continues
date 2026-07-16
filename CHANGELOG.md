# Changelog

All notable changes to `continues` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## Unreleased

### Added

- **Oh My Pi support** — added OMP JSONL session discovery, parsing, handoff extraction, native resume targeting, README coverage, and parser regression tests.

## [4.1.0] - 2026-03-02

### Session Origin Tracking

Handoff output now includes the full file path of the original session, so the receiving tool (or you) can trace back to exactly where the data came from.

### Added

- **Session file path in handoff markdown** — the Session Overview table now has a `Session File` row pointing to the original session file on disk
- **Session Origin section** — new section at the bottom of every handoff document with source tool, file path, session ID, and project directory
- **Session path in resume prompts** — both inline and reference prompts now reference the original session file path

### Fixed

- **`dump` spinner leak** — spinner now stops properly when session loading throws an error, instead of spinning forever
- **`dump` --limit NaN guard** — passing invalid values like `--limit abc` now shows a clear error instead of silently doing nothing

---

## [3.1.0] - 2026-02-22

### Smart Context Display

The handoff markdown that `continues` generates has been completely redesigned. Instead of flat one-liner tool summaries, each tool category now gets **type-aware data capture** at extraction time and **type-aware rendering** at display time.

The previous system discarded ~80-90% of available structured data from tool calls (diffs, stdout, exit codes, line ranges, match counts) and reduced everything to a single summary string. v3.1 captures what matters per tool type and renders it in the format most useful for the receiving AI.

### Added

- **Structured tool data pipeline** — new `StructuredToolSample` discriminated union type with 11 per-category data shapes:
  - `ShellSampleData` — command, exit code, stdout tail, error flag
  - `ReadSampleData` — file path, line start/end
  - `WriteSampleData` — file path, new-file flag, unified diff, diff stats
  - `EditSampleData` — file path, unified diff, diff stats
  - `GrepSampleData` — pattern, target path, match count
  - `GlobSampleData` — pattern, result count
  - `SearchSampleData` — query
  - `FetchSampleData` — URL, result preview
  - `TaskSampleData` — description, agent type, result summary
  - `AskSampleData` — question
  - `McpSampleData` — tool name, truncated params, result preview

- **Minimal diff utility** (`src/utils/diff.ts`) — zero external dependencies:
  - `formatNewFileDiff()` — all-`+` lines for newly created files, capped at 200 lines
  - `formatEditDiff()` — `-`/`+` blocks for search-and-replace edits, capped at 200 lines
  - `extractStdoutTail()` — last N non-empty lines from command output
  - `countDiffStats()` — count added/removed lines from a diff string

- **Category-aware markdown renderer** with per-type templates:
  - **Shell** — blockquote with `$ command`, exit code, and stdout tail in `` ```console `` blocks
  - **Write** — file path with `(new file)` and `(+N lines)` tags, fenced `diff` code block
  - **Edit** — file path with `(+N -M lines)` stats, fenced `diff` code block
  - **Read** — bullet list with optional `(lines 50-120)` range annotations
  - **Grep** — bullet list with `"pattern" in path — N matches`
  - **Glob** — bullet list with `pattern — N files`
  - **Search/Fetch/Task/Ask/MCP** — compact format with extracted key fields

- **Display mode caps** — inline mode (piped into CLI) uses tighter limits; reference mode (`.continues-handoff.md` on disk) gets fuller output:

  | Cap                  | Inline | Reference |
  |----------------------|--------|-----------|
  | Shell detailed       | 5      | 8         |
  | Shell stdout lines   | 3      | 5         |
  | Write/Edit detailed  | 3      | 5         |
  | Write/Edit diff cap  | 50     | 200       |
  | Read entries         | 15     | 20        |
  | Grep/Glob/Search     | 8      | 10        |
  | MCP/Task/Ask         | 3      | 5         |

- **Per-category sample limits** in `SummaryCollector` — prevents any single tool type from dominating the handoff (Shell: 8, Write/Edit: 5, Read: 20, Grep/Glob: 10, MCP/Task/Ask: 5)

- **Error tracking** — `errorCount` on `ToolUsageSummary`, `[ERROR]` tags on failed shell commands

- **20 new tests** covering `classifyToolName`, diff utilities, structured data extraction, and category-aware rendering (258 total, up from 238)

### Changed

- **`SummaryCollector.add()`** — migrated from positional arguments `(category, summary, filePath?, isWrite?)` to options object `(category, summary, opts?: { data?, filePath?, isWrite?, isError? })`

- **`extractAnthropicToolData()`** — full rewrite; first pass stores tool results up to 4000 chars (was 100) with error flags; second pass constructs `StructuredToolSample` per category with rich extracted fields

- **Tool Activity section** in handoff markdown — replaced flat bullet list with category-grouped subsections (`### Shell`, `### Write`, `### Edit`, `### Read`, etc.) in fixed priority order

### Parser updates

- **Codex** — shell commands now capture exit code + stdout tail; `apply_patch` captures the patch as an edit diff; `web_search` and task events captured with structured data
- **Gemini** — `write_file` captures diff from `resultDisplay`, `read_file` captures file path with `ReadSampleData`
- **Copilot** — tool extraction added (was returning empty `toolSummaries[]`); now processes `toolRequests` arrays using `classifyToolName`
- **Claude/Droid/Cursor** — inherit rich structured data automatically via shared `extractAnthropicToolData()`
- **OpenCode** — unchanged (data format lacks structured tool call information)

### Visual: Before vs After

Here is exactly what a receiving AI editor sees when it gets a handoff document.

#### BEFORE (v3.0 — flat summaries)

```markdown
## Tool Activity

- **Bash** (12 calls): `pnpm test`, `pnpm run build`, `git status`, `git diff --stat`... (+8 more)
- **Read** (8 calls): `src/utils/markdown.ts`, `src/types/index.ts`, `src/parsers/codex.ts`... (+5 more)
- **Edit** (6 calls): `src/utils/markdown.ts`, `src/types/index.ts`... (+4 more)
- **Write** (2 calls): `src/utils/diff.ts`, `src/__tests__/shared-utils.test.ts`
- **Grep** (4 calls): `ToolSample`, `extractAnthropicToolData`, `SummaryCollector`... (+1 more)
- **Glob** (3 calls): `**/*.ts`, `**/CHANGELOG*`, `src/__tests__/**`
```

> The receiving AI knows WHAT tools ran, but not WHAT HAPPENED. It cannot see
> diffs, exit codes, stdout, match counts, or line ranges. Every tool call
> is reduced to a one-line label — losing the context that actually matters
> for continuation.

#### AFTER (v3.1 — smart context display)

```markdown
## Tool Activity

### Shell (12 calls, 1 errors)

> `$ pnpm test`
> Exit: 0
> ```
> Test Files  5 passed (5)
>       Tests  258 passed (258)
>    Duration  241ms
> ```

> `$ pnpm run build`
> Exit: 0

> `$ git diff --stat`
> Exit: 0
> ```
>  11 files changed, 1390 insertions(+), 92 deletions(-)
> ```

> `$ tsc --noEmit`
> Exit: 2  **[ERROR]**
> ```
> src/types/index.ts(45,3): error TS2304: Cannot find name 'StructuredToolSample'.
> ```

*...and 8 more shell calls (all exit 0)*

### Write (2 calls)

> **`src/utils/diff.ts`** (new file) (+87 lines)
> ```diff
> +export interface DiffResult {
> +  diff: string;
> +  truncated: number;
> +}
> +
> +export function formatNewFileDiff(content: string, filePath: string, maxLines = 200): DiffResult {
> +  const lines = content.split('\n');
> +  const header = `--- /dev/null\n+++ b/${filePath}`;
> +  const capped = lines.slice(0, maxLines);
> +  const diffLines = capped.map((l) => `+${l}`);
> ```
> *+77 lines truncated*

> **`src/__tests__/shared-utils.test.ts`** (+267 lines)
> ```diff
> +describe('classifyToolName', () => {
> +  it('classifies shell tools', () => {
> +    expect(classifyToolName('Bash')).toBe('shell');
> +  });
> ```
> *+260 lines truncated*

### Edit (6 calls)

> **`src/utils/markdown.ts`** (+472 -36 lines)
> ```diff
> -  if (toolSummaries.length > 0) {
> -    lines.push('## Tool Activity');
> -    lines.push('');
> -    for (const tool of toolSummaries) {
> -      lines.push(`- **${tool.name}** (${tool.count} calls): ${tool.samples.map(s => s.summary).join(', ')}`);
> -    }
> +  if (toolSummaries.length > 0) {
> +    const caps = mode === 'reference' ? REFERENCE_CAPS : INLINE_CAPS;
> +    lines.push('## Tool Activity');
> +    lines.push('');
> +    lines.push(...renderToolActivity(toolSummaries, caps));
> ```
> *+38 lines truncated*

> **`src/types/index.ts`** (+117 -8 lines)
> ```diff
> +export interface ShellSampleData {
> +  category: 'shell';
> +  command: string;
> +  exitCode?: number;
> +  stdoutTail?: string;
> +  errored?: boolean;
> +}
> ```
> *+105 lines truncated*

*...and 4 more edits: `src/utils/tool-extraction.ts` (+257 -30), `src/utils/tool-summarizer.ts` (+70 -20)*

### Read (8 calls)

- `src/utils/markdown.ts`
- `src/types/index.ts`
- `src/parsers/codex.ts`
- `src/utils/tool-extraction.ts`
- `src/utils/tool-summarizer.ts` (lines 1-50)
- `src/parsers/copilot.ts`
- `src/parsers/gemini.ts`
- `src/__tests__/unit-conversions.test.ts` (lines 280-320)

### Grep (4 calls)

- `"ToolSample"` — 23 matches
- `"extractAnthropicToolData"` in `src/utils/` — 4 matches
- `"SummaryCollector"` — 12 matches
- `"classifyToolName"` — 8 matches

### Glob (3 calls)

- `**/*.ts` — 47 files
- `**/CHANGELOG*` — 1 files
- `src/__tests__/**` — 8 files
```

> The receiving AI now sees exactly what happened: which commands failed and why,
> what the diffs look like, which files were read at what line ranges, and how many
> grep matches were found. This is the context needed to pick up where the previous
> session left off — not just labels, but actual outcomes.


---


## [3.0.0] - 2026-02-21

### Breaking Changes

- **Node.js 22+ required** — uses built-in `node:sqlite` for OpenCode parsing
- **Library exports added** — `continues` is now importable as an ESM package (`import { parseSessions, extractContext } from 'continues'`)
- **Type-safe schemas** — all parser inputs are validated through Zod-like runtime schemas; invalid session data is silently skipped instead of crashing

### Added

- **Adapter Registry** (`src/parsers/registry.ts`) — single source of truth for all supported tools. Every parser, CLI command, color, label, resume argument pattern, and storage path is registered in one place. No more switch statements or hardcoded tool lists. Adding a new platform = 3 files, 0 wiring.

- **Registry-driven cross-tool flag forwarding** — when resuming a session in a different tool, `continues` now automatically translates compatible flags (e.g., `--model`, `--allowedTools`) between tool CLIs using registry-defined flag maps.

- **Cursor AI support** — full parser for Cursor's agent transcripts under `~/.cursor/projects/*/agent-transcripts/`. Supports file operations, shell commands, codebase search, and MCP tools.

- **Library entry point** (`src/index.ts`) — exports all types, all parsers, and all utilities for programmatic use. Build AI session analysis tooling on top of `continues` without going through the CLI.

- **Typed runtime schemas** (`src/types/schemas.ts`) — per-tool schema validators for Claude JSONL, Codex JSONL, Gemini JSON, Copilot YAML+JSONL, Droid JSONL, and Cursor JSONL formats. Parsers validate before accessing fields.

- **Content block utilities** (`src/types/content-blocks.ts`, `src/utils/content.ts`) — shared extractors for the Anthropic message format used by Claude, Droid, and Cursor (tool_use, tool_result, text, thinking blocks).

- **Tool name taxonomy** (`src/types/tool-names.ts`) — canonical sets (`SHELL_TOOLS`, `READ_TOOLS`, `WRITE_TOOLS`, `EDIT_TOOLS`, `GREP_TOOLS`, `SEARCH_TOOLS`, `SKIP_TOOLS`, `MCP_TOOL_PATTERN`) used by `SummaryCollector` and the new `classifyToolName()` function.

- **Shared tool extraction** (`src/utils/tool-extraction.ts`) — `extractAnthropicToolData()` handles the two-pass extraction pattern (collect results by ID, then process tool_use blocks) shared by Claude, Droid, and Cursor parsers.

- **JSONL streaming utility** (`src/utils/jsonl.ts`) — `streamJsonl()` and `readJsonl()` replace per-parser readline boilerplate.

- **Filesystem helpers** (`src/utils/fs-helpers.ts`) — `safeReadFile()`, `safeReaddir()`, `safeGlob()` with built-in error suppression.

- **Structured logging** (`src/logger.ts`) — `Logger` class with `DEBUG` and `VERBOSE` levels, replacing scattered `console.log` calls.

- **Custom error types** (`src/errors.ts`) — `ParseError`, `SessionNotFoundError`, `ResumeError`, `IndexError` for better error messages.

- **CLI command modules** — `src/commands/` directory splits the monolithic `cli.ts` (699→~200 LOC) into `list.ts`, `pick.ts`, `resume-cmd.ts`, `scan.ts`, `rebuild.ts`, `quick-resume.ts`, and `_shared.ts`.

- **Display modules** — `src/display/` directory with `banner.ts` (gradient ASCII art), `format.ts` (session formatting), and `help.ts`.

- **Comprehensive test suite** — 238 tests across 5 test files:
  - `schemas.test.ts` — 62 tests validating all runtime schema validators
  - `shared-utils.test.ts` — 46 tests for tool summarizer, extraction, and utility functions
  - `unit-conversions.test.ts` — 112 tests covering all 42 cross-tool conversion paths (7 tools x 6 targets)
  - `forward-flags.test.ts` — 6 tests for cross-tool flag translation
  - `cwd-matching.test.ts` — 12 tests for working directory matching logic

### Changed

- **All 7 parsers rewritten** — Claude, Codex, Copilot, Gemini, OpenCode, Droid, and Cursor parsers now use shared utilities (`streamJsonl`, `extractAnthropicToolData`, `SummaryCollector`, content block helpers) instead of duplicating logic. Average parser LOC reduced ~40%.

- **`SummaryCollector`** (`src/utils/tool-summarizer.ts`) — upgraded from loose strings to typed `ToolSample` objects with deduplicated file tracking and configurable sample limits.

- **Session index** (`src/utils/index.ts`) — uses `Promise.allSettled` for all parsers so one broken parser cannot crash the CLI.

- **Resume logic** (`src/utils/resume.ts`) — consults the adapter registry for binary names, argument patterns, and display strings instead of hardcoded switch blocks.

- **Markdown generator** (`src/utils/markdown.ts`) — now shared by all parsers (previously each parser had inline markdown generation). Produces consistent handoff documents with overview table, tool activity, key decisions, recent conversation, files modified, and pending tasks.

### Removed

- `src/__tests__/conversions.test.ts` — replaced by `unit-conversions.test.ts`
- `src/__tests__/parsers.test.ts` — replaced by `schemas.test.ts` + `shared-utils.test.ts`
- Per-parser inline markdown generation — all parsers now call `generateHandoffMarkdown()`


---


## [2.7.0] - 2026-02-19

### Added

- **Factory Droid support** — `continues` now discovers and parses sessions from [Factory's Droid CLI](https://www.factory.ai/). Full support for cross-tool handoff to and from Droid, including:
  - Session discovery from `~/.factory/sessions/`
  - File operations: `Create`, `Read`, `Edit`, `ApplyPatch`
  - Shell commands: `Execute`, `Bash`
  - MCP tool calls (e.g. `context7___query-docs`)
  - Thinking blocks extracted as reasoning highlights
  - Token usage and model info from companion `.settings.json`
  - Pending tasks from `todo_state` events
- Quick-resume: `continues droid` / `continues droid 3`
- `droid` added to interactive picker, `list --source droid`, `scan`, and cross-tool handoff targets
- Test coverage: 30 conversion paths (up from 20) covering all 6x5 source-target combinations


## [2.6.7] - 2026-02-19

Previous release. Supported Claude Code, GitHub Copilot CLI, Gemini CLI, Codex CLI, and OpenCode.

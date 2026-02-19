# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

`continues` is a CLI tool that lets users resume AI coding sessions across Claude Code, GitHub Copilot CLI, Gemini CLI, Codex CLI, OpenCode, and Factory Droid. It reads each tool's native session storage (read-only), extracts context (messages, file changes, tool activity, AI reasoning), and injects it into a different tool as a structured markdown handoff document.

## Build & Development Commands

```bash
pnpm install              # Install dependencies
pnpm run build            # TypeScript compile (tsc) → dist/
pnpm run dev              # Run with tsx (no build step)
pnpm test                 # Run unit tests (vitest)
pnpm run test:watch       # Watch mode
pnpm run link             # Build + pnpm link --global (local testing as `continues` / `cont`)
```

Run a single test file:
```bash
npx vitest run src/__tests__/unit-conversions.test.ts
```

Requires **Node.js 22+** (uses built-in `node:sqlite` for OpenCode parsing).

## Architecture

### Core Flow

```
CLI (src/cli.ts) → Index (src/utils/index.ts) → Parsers (src/parsers/*.ts) → Markdown (src/utils/markdown.ts) → Resume (src/utils/resume.ts)
```

1. **CLI** (`src/cli.ts`): Commander-based CLI with interactive TUI (@clack/prompts). Handles `list`, `resume`, `scan`, `rebuild`, `pick`, and per-tool quick-resume subcommands (`claude`, `codex`, `gemini`, `copilot`, `opencode`, `droid`).

2. **Session Index** (`src/utils/index.ts`): Builds and caches a unified JSONL index at `~/.continues/sessions.jsonl` (5-min TTL). Calls all six parsers in parallel via `Promise.all`, merges and sorts by `updatedAt`.

3. **Parsers** (`src/parsers/*.ts`): One file per tool. Each exports `parse<Tool>Sessions()` (discovery + metadata) and `extract<Tool>Context()` (full conversation + tool activity extraction). Formats vary:
   - `claude.ts` — JSONL files under `~/.claude/projects/`, streamed with `readline`
   - `codex.ts` — JSONL files under `~/.codex/sessions/`, streamed with `readline`
   - `copilot.ts` — YAML workspace + JSONL events under `~/.copilot/session-state/`
   - `gemini.ts` — JSON files under `~/.gemini/tmp/*/chats/`
   - `opencode.ts` — SQLite DB at `~/.local/share/opencode/opencode.db` (via `node:sqlite`), with JSON file fallback
   - `droid.ts` — JSONL + companion `.settings.json` under `~/.factory/sessions/<workspace-slug>/`

4. **Tool Summarizer** (`src/utils/tool-summarizer.ts`): `SummaryCollector` class + formatting helpers (`shellSummary`, `fileSummary`, `grepSummary`, etc.) shared by all parsers to produce consistent one-line tool activity summaries.

5. **Markdown Generator** (`src/utils/markdown.ts`): `generateHandoffMarkdown()` takes parsed session data and produces the structured handoff document with overview table, tool activity, key decisions, recent conversation, files modified, and pending tasks.

6. **Resume** (`src/utils/resume.ts`): Handles both native resume (same tool) and cross-tool handoff. For cross-tool: extracts context, saves `.continues-handoff.md` to project dir, then spawns the target CLI with the inline or reference prompt.

### Types

`src/types/index.ts` defines: `SessionSource` (union of 6 tool names), `UnifiedSession`, `ConversationMessage`, `ToolCall`, `ToolUsageSummary`, `SessionNotes`, `SessionContext`, `SessionParser`, `ResumeOptions`.

### Adding a New Platform

Adding support for a new AI coding CLI (e.g. "newtool") requires changes in 7 files. The steps below use `codex.ts` as the simplest reference parser.

#### 1. Add to the `SessionSource` type — `src/types/index.ts`

Add the new tool name to the union type:
```ts
export type SessionSource = 'codex' | 'claude' | 'copilot' | 'gemini' | 'opencode' | 'newtool';
```

#### 2. Create the parser — `src/parsers/newtool.ts`

Export two functions following the established pattern:

- `parseNewtoolSessions(): Promise<UnifiedSession[]>` — Discovers session files from the tool's storage directory, reads metadata (id, cwd, repo, branch, timestamps, summary), and returns `UnifiedSession[]` sorted by `updatedAt` descending.
- `extractNewtoolContext(session: UnifiedSession): Promise<SessionContext>` — Reads the full session, extracts `ConversationMessage[]`, uses `SummaryCollector` from `tool-summarizer.ts` to collect tool activity, and calls `generateHandoffMarkdown()` from `utils/markdown.ts` to produce the final markdown. Returns a `SessionContext`.

Key patterns from existing parsers:
- Session discovery: walk the tool's storage directory, filter by file extension/naming pattern.
- For JSONL formats: stream with `readline.createInterface` to avoid loading entire files into memory.
- Use `SummaryCollector.add(category, summary, filePath?, isWrite?)` to accumulate tool usage and track modified files.
- Use the shared formatting helpers (`shellSummary`, `fileSummary`, `grepSummary`, `mcpSummary`, etc.) for consistent one-line summaries.
- Keep only the last ~10 messages in `recentMessages` for the handoff, but ensure at least one user message is included.
- Silently skip files/sessions that fail to parse (`catch {}` blocks).

#### 3. Re-export from the parser barrel — `src/parsers/index.ts`

```ts
export { parseNewtoolSessions, extractNewtoolContext } from './newtool.js';
```

#### 4. Wire into the session index — `src/utils/index.ts`

- Import `parseNewtoolSessions` and `extractNewtoolContext`.
- Add `parseNewtoolSessions()` to the `Promise.all` array in `buildIndex()`.
- Spread the result into `allSessions`.
- Add a `case 'newtool':` in the `extractContext()` switch that calls `extractNewtoolContext`.

#### 5. Add resume commands — `src/utils/resume.ts`

- `nativeResume()`: Add a `case 'newtool':` with the CLI command to resume a session natively (e.g. `newtool --resume <id>`).
- `crossToolResume()`: Add a `case 'newtool':` in the target switch with the CLI syntax for accepting an initial prompt.
- `getResumeCommand()`: Add a `case 'newtool':` that returns the display string for the resume command.

#### 6. Wire into the CLI — `src/cli.ts`

- Add a source color entry: `newtool: chalk.<color>` in the `sourceColors` record.
- Add a human label: `'newtool': 'NewTool'` in `SOURCE_LABELS` (`src/utils/markdown.ts`).
- Add a quick-resume subcommand:
  ```ts
  program
    .command('newtool [n]')
    .description('Resume Nth newest NewTool session (default: 1)')
    .action(async (n = '1') => {
      await resumeBySource('newtool', parseInt(n, 10));
    });
  ```

#### 7. Add test fixtures — `src/__tests__/fixtures/index.ts`

Create a `createNewtoolFixture(): FixtureDir` function that:
- Creates a temp directory matching the tool's storage layout.
- Writes minimal but realistic session data (at least 2 user messages + 2 assistant messages).
- Returns `{ root, cleanup }`.

Then add conversion test cases in `src/__tests__/unit-conversions.test.ts` covering the new tool as both source and target (N-1 new conversion paths for each direction).

## Testing

Tests live in `src/__tests__/`. The vitest config (`vitest.config.ts`) **excludes** several test files by pattern: `e2e*`, `real-e2e*`, `stress*`, `injection*`, `parsers.test*`, `conversions.test*`. The primary test suite is `unit-conversions.test.ts`, which uses fixture data from `src/__tests__/fixtures/index.ts` to test all 30 cross-tool conversion paths (6 tools × 5 targets each) without requiring real session files on the machine.

## Key Conventions

- ESM-only (`"type": "module"` in package.json). All local imports use `.js` extensions.
- `process.exitCode` is set instead of calling `process.exit()` directly.
- The tool suppresses `ExperimentalWarning` from `node:sqlite` at the top of `cli.ts`.
- Session data is **read-only** — the tool never modifies source session files.
- The index cache and handoff contexts are stored under `~/.continues/`.

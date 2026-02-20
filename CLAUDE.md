# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

`continues` is a CLI tool that lets users resume AI coding sessions across Claude Code, GitHub Copilot CLI, Gemini CLI, Codex CLI, OpenCode, Factory Droid, and Cursor AI. It reads each tool's native session storage (read-only), extracts context (messages, file changes, tool activity, AI reasoning), and injects it into a different tool as a structured markdown handoff document.

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
CLI (src/cli.ts) → Registry (src/parsers/registry.ts) → Index (src/utils/index.ts) → Parsers (src/parsers/*.ts) → Markdown (src/utils/markdown.ts) → Resume (src/utils/resume.ts)
```

1. **Adapter Registry** (`src/parsers/registry.ts`): Central `ToolAdapter` interface and `adapters` record. Every supported CLI tool is registered here with its parser functions, resume commands, color, label, and storage path. All other modules derive their behavior from the registry — no manual switch statements or hardcoded tool lists.

2. **CLI** (`src/cli.ts`): Commander-based CLI with interactive TUI (@clack/prompts). Handles `list`, `resume`, `scan`, `rebuild`, `pick`, and per-tool quick-resume subcommands. Quick-resume commands and source colors are generated from the registry automatically.

3. **Session Index** (`src/utils/index.ts`): Builds and caches a unified JSONL index at `~/.continues/sessions.jsonl` (5-min TTL). Calls all parsers in parallel via `Promise.allSettled` (one broken parser won't crash the CLI), merges and sorts by `updatedAt`.

4. **Parsers** (`src/parsers/*.ts`): One file per tool. Each exports `parse<Tool>Sessions()` (discovery + metadata) and `extract<Tool>Context()` (full conversation + tool activity extraction). Formats vary:
   - `claude.ts` — JSONL files under `~/.claude/projects/`, streamed with `readline`
   - `codex.ts` — JSONL files under `~/.codex/sessions/`, streamed with `readline`
   - `copilot.ts` — YAML workspace + JSONL events under `~/.copilot/session-state/`
   - `gemini.ts` — JSON files under `~/.gemini/tmp/*/chats/`
   - `opencode.ts` — SQLite DB at `~/.local/share/opencode/opencode.db` (via `node:sqlite`), with JSON file fallback
   - `droid.ts` — JSONL + companion `.settings.json` under `~/.factory/sessions/<workspace-slug>/`
   - `cursor.ts` — JSONL agent transcripts under `~/.cursor/projects/*/agent-transcripts/`

5. **Shared Utilities** (`src/utils/parser-helpers.ts`): Common functions shared by parsers — `cleanSummary()`, `extractRepoFromCwd()`, `homeDir()`.

6. **Tool Summarizer** (`src/utils/tool-summarizer.ts`): `SummaryCollector` class + formatting helpers (`shellSummary`, `fileSummary`, `grepSummary`, etc.) shared by all parsers to produce consistent one-line tool activity summaries.

7. **Markdown Generator** (`src/utils/markdown.ts`): `generateHandoffMarkdown()` takes parsed session data and produces the structured handoff document with overview table, tool activity, key decisions, recent conversation, files modified, and pending tasks.

8. **Resume** (`src/utils/resume.ts`): Handles both native resume (same tool) and cross-tool handoff. Uses the adapter registry for CLI binary names and argument patterns. For cross-tool: extracts context, saves `.continues-handoff.md` to project dir, then spawns the target CLI with the inline or reference prompt.

### Types

`src/types/index.ts` defines: `SessionSource` (union of 7 tool names), `UnifiedSession`, `ConversationMessage`, `ToolCall`, `ToolUsageSummary`, `SessionNotes`, `SessionContext`, `HandoffOptions`.

### Adding a New Platform

Adding support for a new AI coding CLI (e.g. "newtool") requires changes in **3 files**. Use `codex.ts` as the simplest reference parser.

#### 1. Add to the `SessionSource` type — `src/types/index.ts`

Add the new tool name to the union type:
```ts
export type SessionSource = 'codex' | 'claude' | 'copilot' | 'gemini' | 'opencode' | 'droid' | 'cursor' | 'newtool';
```

#### 2. Create the parser — `src/parsers/newtool.ts`

Export two functions following the established pattern:

- `parseNewtoolSessions(): Promise<UnifiedSession[]>` — Discovers session files from the tool's storage directory, reads metadata (id, cwd, repo, branch, timestamps, summary), and returns `UnifiedSession[]` sorted by `updatedAt` descending.
- `extractNewtoolContext(session: UnifiedSession): Promise<SessionContext>` — Reads the full session, extracts `ConversationMessage[]`, uses `SummaryCollector` from `tool-summarizer.ts` to collect tool activity, and calls `generateHandoffMarkdown()` from `utils/markdown.ts` to produce the final markdown. Returns a `SessionContext`.

Key patterns from existing parsers:
- Import shared utilities: `import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';`
- Session discovery: walk the tool's storage directory, filter by file extension/naming pattern.
- For JSONL formats: stream with `readline.createInterface` to avoid loading entire files into memory.
- Use `SummaryCollector.add(category, summary, filePath?, isWrite?)` to accumulate tool usage and track modified files.
- Keep only the last ~10 messages in `recentMessages` for the handoff, but ensure at least one user message is included.
- Silently skip files/sessions that fail to parse (`catch {}` blocks).

#### 3. Register in the adapter registry — `src/parsers/registry.ts`

Add an entry to the registry with all metadata, parser functions, and resume commands:
```ts
import { parseNewtoolSessions, extractNewtoolContext } from './newtool.js';

register({
  name: 'newtool',
  label: 'NewTool',
  color: chalk.hex('#FF6600'),
  storagePath: '~/.newtool/sessions/',
  binaryName: 'newtool',
  parseSessions: parseNewtoolSessions,
  extractContext: extractNewtoolContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `newtool --resume ${s.id}`,
});
```

That's it — the registry automatically wires the new tool into the CLI (quick-resume commands, source colors, help text, session index, resume logic). No switch statements or hardcoded arrays to update.

#### 4. Add test fixtures — `src/__tests__/fixtures/index.ts`

Create a `createNewtoolFixture(): FixtureDir` function that:
- Creates a temp directory matching the tool's storage layout.
- Writes minimal but realistic session data (at least 2 user messages + 2 assistant messages).
- Returns `{ root, cleanup }`.

Then add conversion test cases in `src/__tests__/unit-conversions.test.ts` covering the new tool as both source and target (N-1 new conversion paths for each direction).

## Testing

Tests live in `src/__tests__/`. The vitest config (`vitest.config.ts`) **excludes** several test files by pattern: `e2e*`, `real-e2e*`, `stress*`, `injection*`, `parsers.test*`, `conversions.test*` (legacy file; the active suite is `unit-conversions.test.ts`). The primary test suite is `unit-conversions.test.ts`, which uses fixture data from `src/__tests__/fixtures/index.ts` to test all 42 cross-tool conversion paths (7 tools × 6 targets each) without requiring real session files on the machine.

## Test-Driven Development

Every code change should follow TDD discipline:

1. **Write the test first** — parser changes, new features, and bug fixes all start with a failing test.
2. **Ground fixtures in real schemas** — before creating fixture data, read a real session file to verify field names and data structure. Use the Read tool or MCP to inspect the actual storage paths (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.copilot/session-state/`, `~/.gemini/tmp/*/chats/`, `~/.local/share/opencode/`, `~/.factory/sessions/`, `~/.cursor/projects/*/agent-transcripts/`).
3. **If real session data isn't available** — ask the user to provide a sample or point to the storage directory. Don't invent schemas from imagination.

### Test file conventions

- **Parser/conversion tests**: `src/__tests__/unit-conversions.test.ts` — the primary test suite (fixture-based, all conversion paths)
- **Utility tests**: dedicated files (e.g. `src/__tests__/cwd-matching.test.ts`)
- **Fixtures**: `src/__tests__/fixtures/index.ts` — one `createXxxFixture()` factory per tool

### Minimum test coverage for PRs

- **New parser**: fixture factory + low-level parsing tests + all N-1 conversion paths in each direction
- **New utility function**: dedicated test file with edge cases
- **Bug fix**: regression test that reproduces the bug before the fix is applied

## Key Conventions

- ESM-only (`"type": "module"` in package.json). All local imports use `.js` extensions.
- `process.exitCode` is set instead of calling `process.exit()` directly.
- The tool suppresses `ExperimentalWarning` from `node:sqlite` at the top of `cli.ts`.
- Session data is **read-only** — the tool never modifies source session files.
- The index cache and handoff contexts are stored under `~/.continues/`.

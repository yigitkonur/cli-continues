# AGENTS.md

Agent behavior instructions for `continues` — the cross-tool AI session handoff CLI. Read `CLAUDE.md` for architecture, types, and the step-by-step guide for adding a new parser. This file covers workflow, coding standards, and anti-patterns.

## Workflow

- **Before any commit**: run `pnpm run check` (`pnpm lint && pnpm build`). Fix all Biome errors; warnings are advisory.
- **After changing a parser or fixture**: run `pnpm test` and confirm all tests pass. Do not commit with failing tests.
- **After adding a new tool**: run `pnpm run link` to test the global `continues` / `cont` binary locally.
- **Never run** `pnpm run test:watch`, `e2e-conversions.test.ts`, `real-e2e-full.ts`, or `stress-test.ts` in CI — these require live session files on the developer's machine.

## Coding Standards

- **ESM-only**: all local imports must end in `.js`, even for `.ts` source files (e.g., `import { foo } from './foo.js'`).
- **No `any`**: Biome reports `noExplicitAny` as a warning. Avoid it; document the reason if unavoidable.
- **Exit codes**: set `process.exitCode = N` rather than calling `process.exit(N)`.
- **Logging**: use `logger` from `src/logger.ts` for all diagnostic output. Never use bare `console.log`/`console.warn`/`console.error` in library code. TUI display goes through `@clack/prompts` or `chalk` via the display layer.
- **Error types**: throw typed errors from `src/errors.ts` on user-facing paths, not bare `new Error()`.
- **Tool activity**: use `SummaryCollector` from `src/utils/tool-summarizer.ts` in every parser. Do not build `ToolUsageSummary[]` arrays manually.
- **JSONL**: use the shared streaming helpers in `src/utils/jsonl.ts`, never `fs.readFileSync` + `split('\n')`.
- **SQLite** (OpenCode, Crush parsers): use built-in `node:sqlite` — do not add third-party SQLite dependencies.
- **Biome rules in force**: `noEmptyBlockStatements` (error), `noUnusedImports` (error), `useConst` (error). Empty `catch {}` blocks fail the linter; use `catch (err) { logger.debug(...) }` instead.

## Adding a New Tool — Checklist

All five steps are required. Missing any one is a bug. See `CLAUDE.md` for detailed implementation guidance.

1. Add tool name to `TOOL_NAMES` in `src/types/tool-names.ts`
2. Create `src/parsers/<tool>.ts` exporting `parse<Tool>Sessions()` and `extract<Tool>Context()`
3. Register in `src/parsers/registry.ts` (the completeness assertion throws at module load if missing)
4. Add `create<Tool>Fixture()` in `src/__tests__/fixtures/index.ts`
5. Add conversion test cases in `src/__tests__/unit-conversions.test.ts`

## Dependencies

- **`@clack/prompts`** — all interactive TUI prompts and spinners. Do not use `readline` or `inquirer`.
- **`chalk`** — terminal color. Chalk v4 is installed (CommonJS compat import); do not upgrade to v5+ (ESM-only).
- **`commander`** — CLI argument parsing.
- **`ora`** — non-interactive spinners.
- **`yaml`** — YAML parsing for Copilot sessions.
- **`zod`** — runtime schema validation. Use `z.safeParse()` where failures are recoverable.
- Do not add new runtime dependencies without strong justification. The install footprint is intentionally small.

## Anti-Patterns to Avoid

- **Writing to tool storage directories** — the tool is read-only. Any write to `~/.claude/`, `~/.codex/`, etc. is a severe bug.
- **`exec()` with string interpolation** — always use `spawn()` with an argument array in `resume.ts`. Session IDs and paths can contain shell metacharacters.
- **`fs.readFileSync`/`fs.writeFileSync` in parsers** — these block the event loop. Use async fs APIs or shared streaming helpers.
- **Duplicating parser-helpers** — `cleanSummary`, `extractRepoFromCwd`, `homeDir` live in `src/utils/parser-helpers.ts`. Import them; do not reimplement.
- **Hardcoding tool names** — derive from `TOOL_NAMES` or `SessionSource`. Never write `if (tool === 'claude' || tool === 'codex' || ...)`.
- **Importing `node:sqlite` outside OpenCode/Crush parsers** — SQLite is only needed for those two tools. Do not spread this dependency.
- **Embedding secrets in handoff markdown** — `.continues-handoff.md` is written to project directories and may be committed or read by other AI tools.

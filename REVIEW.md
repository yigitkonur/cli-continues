# REVIEW.md

Review guidelines for the `continues` CLI tool — a read-only session parser and cross-tool handoff generator for AI coding CLIs.

## Critical Areas

- **Parser files** (`src/parsers/*.ts`): Each parser reads from a different tool's session storage. Changes must preserve read-only semantics — the tool must never write to or modify source session files. Verify that new parsers handle malformed/missing data gracefully (silent `catch {}` blocks, not thrown errors that crash the CLI).
- **Registry** (`src/parsers/registry.ts`): Single source of truth for all tool adapters. Any change here affects every tool. Verify the completeness assertion at the bottom still passes — every `SessionSource` must have a registered adapter.
- **Resume logic** (`src/utils/resume.ts`): Spawns external CLI processes. Review for command injection — user-controlled session IDs and paths are passed as CLI arguments. Ensure arguments are passed as array elements to `spawn()`, never interpolated into a shell string.
- **Forward flags** (`src/utils/forward-flags.ts`): Maps CLI flags across tools with different permission models. Flag precedence logic (auto-approve > full-auto > sandbox) is security-sensitive — incorrect mapping could grant unintended permissions in the target tool.
- **Type definitions** (`src/types/index.ts`, `src/types/tool-names.ts`): Changes to `SessionSource` or `TOOL_NAMES` require corresponding updates in the registry, fixtures, and tests.

## Conventions

- ESM-only: all local imports must use `.js` extensions, even for `.ts` source files.
- Use `process.exitCode = N` instead of `process.exit(N)`.
- Biome handles linting and formatting — do not introduce ESLint or Prettier configs.
- Parser functions must return `Promise<UnifiedSession[]>` and `Promise<SessionContext>` respectively. Both must be registered in `src/parsers/registry.ts`.
- JSONL parsing must use the shared streaming helpers in `src/utils/jsonl.ts` where possible — do not load entire files into memory with `fs.readFileSync`.
- Use the `SummaryCollector` class from `src/utils/tool-summarizer.ts` for tool activity summaries. Do not manually build summary arrays.
- Shared helpers (`cleanSummary`, `extractRepoFromCwd`, `homeDir`) live in `src/utils/parser-helpers.ts`. Do not duplicate these in individual parsers.
- Error hierarchy: use typed errors from `src/errors.ts` (`ParseError`, `SessionNotFoundError`, `ToolNotAvailableError`, `UnknownSourceError`, `IndexError`, `StorageError`) rather than bare `throw new Error()` for user-facing error paths.
- Use `logger` from `src/logger.ts` for diagnostic output inside catch blocks — do not use raw `console.log`, `console.warn`, or `console.error`. Silent empty `catch {}` blocks violate the Biome `noEmptyBlockStatements` rule; use `logger.debug` or `logger.warn` instead.

## Security

- Session data is **read-only**. Any PR that writes to tool storage directories (`~/.claude/`, `~/.codex/`, `~/.copilot/`, etc.) is a severe bug.
- External process spawning in `resume.ts` must use `spawn()` with arguments as an array, never `exec()` with string interpolation. This prevents command injection via session IDs or file paths containing shell metacharacters.
- The `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` flags in forward-flag mapping are security-critical. Verify these are only set when the source session explicitly requested auto-approve behavior.
- Handoff markdown files (`.continues-handoff.md`) are written to project directories and may be read by other AI tools. Do not embed secrets, API keys, or environment variable values in handoff output.

## Performance

- Parsers run in parallel via `Promise.allSettled` in the session index builder. A slow parser blocks only its own results, not the entire index. However, flag any parser that performs synchronous I/O or blocks the event loop.
- The session index uses a 5-minute TTL cache (`~/.continues/sessions.jsonl`). Changes that bypass or invalidate the cache should be justified.
- Flag any use of `fs.readFileSync` or `fs.writeFileSync` in parser code — these block the event loop and can stall the CLI when scanning large session directories.
- SQLite access (OpenCode, Crush parsers) uses `node:sqlite`. Queries should be parameterized and avoid scanning entire tables when filtering by session ID.

## Patterns

### Adding a New Parser

Every new parser must follow this three-file pattern. Missing any of these is a bug.

1. **Parser file** — `src/parsers/<tool>.ts` exporting `parse<Tool>Sessions()` and `extract<Tool>Context()`
2. **Registry entry** — `src/parsers/registry.ts` with all `ToolAdapter` fields populated
3. **Type update** — `src/types/tool-names.ts` adding the tool to `SessionSource` and `TOOL_NAMES`
4. **Test fixtures** — `src/__tests__/fixtures/index.ts` with a `create<Tool>Fixture()` factory
5. **Conversion tests** — `src/__tests__/unit-conversions.test.ts` covering all N-1 paths in each direction

### Error Handling in Parsers

Parsers must never crash the CLI. Malformed session files should be silently skipped.

**Good:**
```typescript
try {
  const data = JSON.parse(line);
  // process data...
} catch (err) {
  logger.debug('skipping malformed line', err);
}
```

**Bad:**
```typescript
const data = JSON.parse(line); // Throws on malformed input, crashes CLI
```

### Tool Summarizer Usage

Always use `SummaryCollector` — do not build tool summaries manually.

**Good:**
```typescript
const collector = new SummaryCollector();
collector.add('shell', shellSummary(cmd, exitCode), undefined, false);
collector.add('write', fileSummary(filePath, 'write'), filePath, true);
return collector.finalize();
```

**Bad:**
```typescript
const toolSummaries: ToolUsageSummary[] = [];
toolSummaries.push({ name: 'Bash', count: 1, samples: [{ summary: cmd }] });
```

## Testing

- The primary test suite is `src/__tests__/unit-conversions.test.ts`. All 14 tools x 13 targets = 182 conversion paths must pass.
- PRs that change parser logic must include or update fixture data in `src/__tests__/fixtures/index.ts`.
- PRs that add source files under `src/` but do not touch any test files should be flagged — the CI will also flag this via the test-quality job.
- Node.js 22+ is required. The `node:sqlite` built-in is used by OpenCode and Crush parsers. Do not add third-party SQLite dependencies.
- Test timeout is 30 seconds (`vitest.config.ts`). If a test needs more, the parser likely has a performance problem.

## Ignore

- `dist/` — compiled output, auto-generated by `tsc`.
- `node_modules/` — dependency tree.
- `pnpm-lock.yaml`, `package-lock.json` — lock files, unless dependency changes are part of the PR.
- `CHANGELOG.md` — auto-generated by release tooling.
- `demo.mp4` — demo video, not code.
- `test-fixtures/` — legacy fixture directory (active fixtures are in `src/__tests__/fixtures/`).
- `.DS_Store` — macOS metadata.

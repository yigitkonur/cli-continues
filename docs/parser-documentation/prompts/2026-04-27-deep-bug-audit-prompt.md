# Deep Bug Audit Prompt

You are auditing this repository as a senior debugging agent. Your job is to discover plausible correctness, reliability, data-loss, security, and user-facing CLI bugs from the code itself. Do not assume any bug exists. Do not start from a named issue. Start from the repo's architecture, contracts, code style, and tests, then prove or discard each suspicion with evidence.

## Mission

Find the highest-impact hidden bugs that could make this CLI:

- resume, list, inspect, dump, or hand off the wrong session
- silently drop important context
- parse real-world tool transcripts incorrectly
- write files before validation or into the wrong location
- return misleading output, status, or exit codes
- corrupt or serve stale cache/index data
- behave differently in non-TTY, CI, Windows, or unusual shell environments
- fail when paths, arguments, payloads, transcripts, or markdown become large
- expose secrets or unintended content in generated handoff material

Treat this as a code-led investigation. The expected output is not a broad code review. The expected output is a prioritized list of confirmed or strongly evidenced bugs, each with a minimal reproduction or a precise regression test plan.

## Repository Orientation

This is `continues`, a TypeScript ESM CLI for discovering and resuming AI coding sessions across multiple tools.

Key areas to inspect:

- CLI entrypoint and command flow: `src/cli.ts`, `src/commands/*`
- Parser registry and adapter contracts: `src/parsers/registry.ts`, `src/parsers/index.ts`
- Per-tool parsers: `src/parsers/*.ts`
- Handoff/resume execution: `src/utils/resume.ts`, `src/utils/forward-flags.ts`
- Index/cache/session lookup: `src/utils/index.ts`, `src/utils/fs-helpers.ts`, `src/utils/jsonl.ts`
- Markdown and content extraction: `src/utils/markdown.ts`, `src/utils/content.ts`, `src/utils/tool-extraction.ts`, `src/utils/tool-summarizer.ts`
- Types and runtime schemas: `src/types/*`
- Regression patterns: `src/__tests__/*.test.ts`, `test-fixtures/`, `docs/parser-documentation/`

Read `AGENTS.md` and `CLAUDE.md` first if present. Follow their constraints.

## Ground Rules

- Work locally first. Do not create branches, commits, or PRs unless explicitly asked.
- Do not write to real tool storage directories under home directories.
- Do not run live e2e, stress, or real-machine tests unless explicitly asked.
- Prefer `rg`, `rg --files`, and focused file reads over broad dumps.
- Prefer primary vendor docs only when checking external CLI behavior or storage formats.
- Do not rely on comments alone. Verify behavior from code, fixtures, tests, or official docs.
- Distinguish confirmed facts from inference.
- If you edit code, keep fixes and tests tightly scoped to the confirmed bug.

## Investigation Method

### 1. Build the Mental Model

Map the main contracts before hunting:

- How a session is discovered, normalized, cached, and selected.
- How each parser converts native transcript records into `UnifiedSession` and `SessionContext`.
- How handoff markdown is produced and passed into target tools.
- How command flags are parsed, forwarded, ignored, or transformed.
- How errors and exit codes propagate through command handlers.
- How tests construct fake homes, fixtures, env vars, and parser inputs.

Write down the expected invariant for each contract in one sentence. Then search for code that violates or weakens that invariant.

### 2. Hunt by Risk Surface

Use these lenses. For each lens, search the code for likely patterns, then inspect the surrounding implementation and tests.

#### Parser Shape Drift

Look for assumptions that real transcripts always have one shape:

- single field names where historical or namespaced variants may exist
- unguarded nested property reads
- ignored top-level record types
- arrays treated as strings or strings treated as arrays
- broad `unknown` casts without schema validation
- event tails sliced before non-conversation rows are filtered
- message timestamps, cwd, branch, or ids derived from filesystem metadata when transcript metadata is available

Evidence to collect:

- exact parser branch that drops or misclassifies a valid record
- minimal JSONL fixture showing the drop
- expected normalized output

#### Context Preservation

Look for ways recent user intent, compact summaries, tool results, diffs, or sidecar outputs can disappear:

- truncation before classification
- dedupe keys that collapse distinct items
- max-count limits applied before filtering for importance
- tool-only rows crowding out user-visible conversation
- summary extraction that ignores canonical compacted state
- sidecar files found by only one naming pattern
- markdown renderers that omit structured samples despite extraction

Evidence to collect:

- where the data exists in the native record
- where it is lost
- whether generated markdown or `SessionContext` omits it

#### Transport and Size Boundaries

Inspect how handoff content, paths, prompts, and arguments move between processes:

- `spawn()` argument arrays, shell usage, quoting, and path handling
- inline prompt construction and reference-file construction
- target-specific limits implied by command style
- stdout/stderr discipline for data vs. diagnostics
- behavior when markdown, args, paths, env vars, or session ids are large

Evidence to collect:

- code path that passes a large or structured payload through a fragile boundary
- safer existing path in the repo, if any
- observable failure mode or testable threshold

#### Cache and Index Correctness

Search for stale or wrong-session cache paths:

- env vars that affect parser roots but are absent from fingerprints
- source-specific lookups that accidentally rebuild all sources or reuse wrong caches
- TTL checks that ignore schema/version changes
- cache lines that cannot parse but are silently skipped
- force rebuild flags not reaching the relevant function
- cwd filters applied after expensive global discovery when direct lookup is available

Evidence to collect:

- sequence of calls that returns stale or wrong sessions
- env var or cwd change that should invalidate cache
- expected cache rebuild behavior

#### Filesystem and Path Portability

Look for assumptions that break on unusual paths or platforms:

- slug/cwd conversions that are not reversible enough
- absolute vs. relative path confusion
- path separators hardcoded as `/`
- symlink, case-sensitivity, or whitespace path issues
- sync filesystem calls in hot parser loops
- writes into project directories before validation
- temp files without cleanup or predictable names

Evidence to collect:

- input path or cwd that triggers the issue
- code path that maps it incorrectly
- whether Windows-safe tests cover the case

#### CLI UX, Exit Codes, and Non-TTY Behavior

Check command handlers as scriptable tools:

- invalid inputs that continue after setting `process.exitCode`
- non-TTY code paths that prompt or spin unexpectedly
- JSON/JSONL output polluted by progress, color, or warnings
- unknown flags swallowed when they should fail
- required args accepted as empty strings
- debug modes that still launch external commands
- command display diverging from actual spawn args

Evidence to collect:

- command invocation
- stdout/stderr/exit-code expectation
- current behavior from code or a safe local run

#### Security and Secret Leakage

Inspect generated markdown and context extraction:

- environment variables, auth tokens, headers, cookies, config files, or local paths included in handoff
- shell outputs or tool results copied without redaction
- generated files placed where they may be committed
- error messages containing sensitive paths or payloads
- broad inclusion of hidden files or tool storage internals

Evidence to collect:

- source of sensitive data
- render path into markdown or output
- proposed redaction or exclusion rule

#### Registry Completeness and Tool Vocabulary

Search for hardcoded tool lists or classification drift:

- `TOOL_NAMES` additions not reflected in adapters, labels, schemas, tests, docs, or fixture helpers
- tool aliases missing from read/write/edit/search/shell sets
- native resume command display differing from actual args
- cross-tool forwarded flags accepted by one target but invalid for another
- parser-specific tool names bypassing shared `SummaryCollector`

Evidence to collect:

- inconsistent list or missing alias
- user-visible behavior affected
- regression test location

### 3. Search Strategy

Start with targeted queries, then follow code paths:

```bash
rg -n "TODO|FIXME|HACK|as any|as unknown|JSON.parse|process.exit|exitCode|spawn|exec|writeFile|readFileSync|slice\\(|truncate|limit|cache|fingerprint|envVar|cwd|originalPath|resumeCommandDisplay|nativeResumeArgs|allowUnknownOption|debugPrompt|noTui" src
rg -n "readJsonlFile|scanJsonlHead|scanJsonlFile|findFiles|listSubdirectories|SummaryCollector|generateHandoffMarkdown|extractContext|parseSessions" src
rg -n "CLAUDE|CODEX|COPILOT|FACTORY|DROID|GEMINI|OPENCODE|CURSOR|AMP|KIRO|CRUSH|CLINE|ROO|KILO|ANTIGRAVITY|KIMI|QWEN" src
```

Then inspect tests for missing negative cases:

```bash
rg -n "invalid|large|truncate|cache|env|cwd|windows|debug|no-tui|jsonl|resume|sidecar|compact|tool_result|create|edit|patch" src/__tests__ test-fixtures docs/parser-documentation
```

Prefer proving one issue deeply over listing many shallow suspicions.

## Confirmation Standard

Classify each candidate:

- Confirmed: reproducible with a failing focused test or safe command.
- Strongly evidenced: code path and fixture shape show the failure, but execution is blocked by environment.
- Plausible only: worth noting, but do not present as a bug.
- Discarded: hypothesis checked and code/tests already cover it.

For each confirmed or strongly evidenced finding, include:

1. Severity: P0, P1, P2, or P3.
2. Affected surface: command, parser, cache, markdown, registry, filesystem, security, or tests.
3. Invariant violated.
4. Minimal reproduction or fixture.
5. Root cause with file and line references.
6. Suggested fix.
7. Regression test plan.
8. Verification command.

## Severity Guide

- P0: data loss, secret exposure, destructive writes, or wrong external command that can mutate user state.
- P1: wrong session resumed, context silently omitted, stale cache from normal workflows, invalid target accepted after writes, or common parser format dropped.
- P2: edge-case parser miss, misleading diagnostics, non-TTY scriptability issue, performance cliff, or platform-specific break.
- P3: low-impact polish, confusing wording, weak test coverage without demonstrated user impact.

## Output Format

Return this structure:

```markdown
# Debug Audit Results

## Scope
<files and commands inspected>

## Executive Findings
| ID | Severity | Surface | Status | One-line impact |
|---|---|---|---|---|

## Findings

### <ID>: <short title>
- Severity:
- Status:
- Invariant:
- Evidence:
- Root cause:
- Minimal reproduction:
- Suggested fix:
- Regression test:
- Verification:

## Discarded Hypotheses
| Hypothesis | Why discarded |
|---|---|

## Test Gaps
<high-value missing tests even if no bug was confirmed>

## Next Commands
<exact commands to run next, if any>
```

Do not pad the report. If no confirmed bugs are found, say that directly and focus on the most valuable test gaps or remaining unknowns.

## Optional Fix Mode

If asked to fix after the audit:

- Make one bug fix at a time.
- Add or update the smallest regression test that would have caught it.
- Run the narrow test first, then `pnpm test`, then `pnpm run check` if the repo requires it.
- Do not include unrelated formatting unless needed for the check gate.
- Stop after the verified micro-task and report exactly what changed.

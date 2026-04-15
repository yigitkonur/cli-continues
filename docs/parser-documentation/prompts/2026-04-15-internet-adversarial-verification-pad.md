# Internet Adversarial Verification Pad

Repository: `/Users/yigitkonur/dev/cli-continues`

This pad is for external verification agents. Treat the current local implementation and research package as **suspect**. The job is to challenge it, find counter-evidence, and prove where the reasoning is weak, stale, or incomplete.

## Current Local Implementation Under Review

### Code changes

- `src/cli.ts`
- `src/commands/resume-cmd.ts`
- `src/utils/resume.ts`
- `src/__tests__/resume-debug-prompt.test.ts`
- `src/__tests__/resume-command-debug.test.ts`
- `README.md`

### What changed

The current implementation added a `--debug-prompt` flag to `continues resume`. In cross-tool mode, it:

- still extracts context
- still writes `.continues-handoff.md`
- prints the exact prompt that would be sent to the target tool
- exits without launching the target CLI

It also rejects `--debug-prompt` for same-tool/native resume.

### Current local evidence

- targeted tests for `--debug-prompt` pass
- full `pnpm test` passes
- `pnpm build` passes
- repo-wide `pnpm run check` still fails because of a pre-existing unrelated Biome backlog
- a live CLI smoke test printed the exact handoff prompt in plain text

## Current Research Package Under Review

Start here:

- `docs/parser-documentation/00-overview.md`
- `docs/parser-documentation/99-open-questions.md`
- `docs/parser-documentation/storage-format/00-overview.md`
- `docs/parser-documentation/message-schema/00-overview.md`
- `docs/parser-documentation/tool-call-map/00-overview.md`
- `docs/parser-documentation/access-recipes/00-overview.md`
- `docs/parser-documentation/handoff-pointers/00-overview.md`
- `docs/parser-documentation/prompts/2026-04-15-default-full-handoff-redesign.md`
- `docs/parser-documentation/prompts/2026-04-15-sessionr-codex-implementer.md`

### Core claims the repo currently believes

1. The current user-facing `minimal | standard | verbose | full` model should eventually become `default | full`.
2. Handoffs should start with a technical pointer block before the summary/conversation body.
3. Exact upstream tool/function names are currently normalized away too aggressively.
4. Assistant-message reconstruction must be tool-specific.
5. The highest-risk backend drift is around `gemini`, `kiro`, `antigravity`, `qwen-code`, `crush`, `amp`, `kilo-code`, and `cursor`.
6. `sessionr` is a viable path for handing the implementation brief to a Codex session, but its `--async` path appears broken on this machine.

## Explicit Doubt Vectors

Attack these aggressively:

### Doubt vector A: schema drift claims may be wrong

Look for current first-party docs, release notes, repo code, or issue tracker evidence that contradicts the repo’s conclusions about:

- Gemini JSON vs JSONL
- Kiro JSON vs SQLite
- Antigravity `code_tracker` vs conversations protobuf/tracker JSON
- Qwen runtime roots and env vars
- Crush DB path defaults
- Amp thread storage
- Kilo Code backend family
- Cursor transcript completeness

### Doubt vector B: the redesign direction may be overstated

Look for evidence that:

- four presets are still justified
- `default | full` is too simplistic
- a pointer block could be unsafe, misleading, or too backend-fragile
- preserving exact tool names could hurt clarity more than it helps

### Doubt vector C: the `--debug-prompt` implementation may be flawed

Look for evidence and arguments that:

- writing the handoff file before printing may be the wrong behavior
- same-tool rejection is the wrong constraint
- prompt emission should be machine-readable instead of plain text
- there are safer or more standard ways to expose the outbound prompt

### Doubt vector D: the `sessionr` orchestration path may be wrong

Look for current docs, issues, or repo evidence about:

- the correct sync vs async contract
- whether `--async` is known-broken or environment-specific
- the best way to recover created session IDs
- whether nested Codex environments distort `sessionr` output

## What A Good Verification Response Contains

- challenge the repo’s claims, do not merely restate them
- give first-party URLs wherever possible
- separate:
  - contradicted
  - supported
  - still unresolved
- include counter-arguments, not only confirmations
- use a discussion style when useful: “the claim looks plausible because X, but may be wrong because Y”

## Access Date

All local files above were current on 2026-04-15.

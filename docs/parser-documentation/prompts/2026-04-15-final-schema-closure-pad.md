# Final Schema Closure Verification Pad

Repository: `/Users/yigitkonur/dev/cli-continues`

This is the final deep research pass intended to reduce the unresolved set as far as current first-party evidence allows. Treat both the original local research and the first adversarial wave as useful but incomplete. Your job is to close the remaining gaps, not to restate already-settled claims.

## Read First

Read these local files before researching:

- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/00-overview.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/01-parser-redesign-backlog.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/99-open-questions.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/prompts/2026-04-15-default-full-handoff-redesign.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/prompts/2026-04-15-sessionr-codex-implementer.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/prompts/2026-04-15-internet-adversarial-verification-pad.md`
- `/Users/yigitkonur/dev/cli-continues/docs/research/high-risk-schema-family-b-adversarial-verification/00-master-summary.md`
- `/Users/yigitkonur/dev/cli-continues/docs/research/high-risk-schema-family-b-adversarial-verification/docs/01-seven-tool-adversarial-verification.md`

## Goal

Reduce the remaining uncertainty set by finding:

- stronger first-party confirmations
- stronger first-party contradictions
- GitHub-native repo/issue/discussion context
- any current release-note or changelog evidence that shifts confidence

Use discussion-style reasoning in your own process: argue both sides where evidence conflicts, then conclude with a confidence level.

## What Is Already Strong Enough

Do not spend much time re-proving these:

- Gemini is JSONL-first upstream now
- Kiro normal CLI storage is SQLite-backed under `~/.kiro/`
- Kiro ACP sessions persist as `.json` + `.jsonl`
- Cursor transcript fidelity loss around tool outputs is real
- Copilot per-session files are the complete record and `session-store.db` is a subset/index
- Crush is project-local `.crush/crush.db`
- `sessionr --new --async` is too weak for deterministic new-session-ID recovery even if not publicly “known broken”

## Remaining Closure Targets

### Domain A: Antigravity, Amp, Droid

Still unclear:

- Antigravity canonical session store
- whether `code_tracker` is transcript data or auxiliary tracking only
- whether public `History` / `workspaceStorage` reports indicate a different store
- whether Amp has a first-party local transcript path/schema at all
- whether Droid should anchor on `projects/.../*.jsonl`, `sessions/...`, or a versioned mix

### Domain B: Kilo Code, Qwen Code, Kiro detailed schema

Still unclear:

- whether Kilo’s extension-side `ui_messages.json` and shared-core/DB-backed storage should both be treated as current product surfaces
- whether Qwen’s `projects/` vs `tmp/` wording is just stale commentary or a real versioned split
- whether Kiro’s exact SQLite DB/schema for normal CLI chat is visible in first-party repo/docs

### Domain C: Design contract and machine/inspection surface

Still unclear:

- whether `default | full` should remain the leading implementation direction
- whether a separate machine/inspection axis is strongly supported by first-party patterns
- whether pointer blocks should lead, or just appear early and stay concise

### Domain D: sessionr + outbound prompt debugging contract

Still unclear:

- whether there is stronger repo/issue evidence about `sessionr` async/job behavior
- whether structured machine-readable prompt-debug output is better supported than raw plain text
- whether same-tool debug rejection should remain a hard error or become a “show native resume command” path

## Required Output Style

For each domain, produce:

1. Summary
2. New confirmations beyond the first wave
3. New contradictions beyond the first wave
4. Still unresolved after this final pass
5. URLs

Do not edit repo files yourself. Return evidence only.

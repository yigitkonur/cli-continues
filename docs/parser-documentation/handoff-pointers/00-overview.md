# Handoff Pointer Redesign Overview

## Why this context exists

The current handoff markdown starts with a readable session overview, not a raw-storage briefing. In `src/utils/markdown.ts`, the top section is a generic table with source, session ID, working directory, optional session file, and message count; the raw source path is repeated later under `## Source Data`, after summaries, tool activity, reasoning, and recent conversation. In `src/config/verbosity.ts`, the top-level contract is still `minimal | standard | verbose | full`, which makes volume tunable but does not make the first screen more navigable.

This folder recommends replacing that model with a two-mode pointer contract:

- `default`: concise, operational, enough to continue safely
- `full`: same first block expanded with backend-specific depth and retrieval recipes

The pointer block should come before the summary/conversation body.

## Default-mode contract

Every tool-specific default pointer should try to expose:

- `Source` and `session ID`
- `Raw source path` or `DB path + session key`
- `Raw backend/format` such as JSONL, JSON, YAML+JSONL, or SQLite
- `Volume` as lines, messages, or rows when cheap to compute
- `Native continue handle` such as session ID, thread ID, or resume command
- `Quick inspect` recipe tailored to the backend
- `Confidence note` when the parser is using a legacy or export-only format

This is the smallest useful block that lets a downstream agent decide whether the current markdown is enough or whether it should inspect the raw store directly.

## Full-mode contract

`full` should keep the same first six fields, then add only backend-specific depth:

- Companion artifacts such as sidecar settings, tool-results folders, subagent logs, checkpoints, or DB tables
- Record-type counts when the backend is append-only and counting is practical
- Two to four direct retrieval commands or SQL queries
- Parser caveats versus upstream reality
- Variant markers for tools that have legacy and current formats in the wild

The key design point: `full` should add navigational depth, not just more prose.

## Strongest findings

- `Claude`, `Copilot`, `Cline`, `Roo Code`, `Kilo Code`, `Kimi`, `Crush`, and `Qwen Code` all support high-value pointer blocks because their raw stores are deterministic enough to name concrete files and retrieval commands.
- `OpenCode` needs a variant-aware pointer because real installations may have both legacy JSON storage and SQLite, and migration behavior is a known source of drift.
- `Codex` needs a split pointer between documented `CODEX_HOME` state and the actual rollout file the parser is reading. The docs emphasize `history.jsonl`; the open-source CLI code writes resumable rollouts under `sessions/YYYY/MM/DD/rollout-*.jsonl`.
- `Cursor` needs a completeness warning. First-party forum posts confirm local `agent-transcripts` files exist, but Cursor staff also acknowledged that at least one `.jsonl` transcript/export path dropped `tool_use` data and likely omits `tool_result`.
- `Gemini`, `Kiro`, and `Antigravity` are the highest-risk mismatches:
  - `Gemini`: upstream repo code now records append-only JSONL chat logs, while `continues` still parses older single-file JSON session objects.
  - `Kiro`: official docs describe SQLite under `~/.kiro/`, while `continues` still parses legacy-looking JSON session files.
  - `Antigravity`: upstream Gemini repo now exposes tracker JSON under per-project temp/session directories, while `continues` still targets an older `code_tracker` line-oriented format.
- `Droid` and `Amp` have weaker first-party disclosure for on-disk raw session layout than the repo currently assumes. Their pointer blocks should include confidence labels until the raw stores are re-verified from local captures or stronger first-party evidence.

## Recommended repo-level direction

1. Replace the current preset names with a first-class `pointerMode: default | full`, and let the existing low-level caps stay internal.
2. Move the raw-storage pointer block to the top of the handoff, ahead of summary and recent conversation.
3. Make the pointer block variant-aware for tools with known format drift (`gemini`, `opencode`, `kiro`, `antigravity`, possibly `kilo-code`).
4. Add an explicit `schema confidence` field when the parser is built from observation rather than published first-party storage docs.
5. Prefer direct-access recipes over narrative. A receiver should be able to copy one command and deepen immediately.

## High-risk comparisons with current code

- `src/utils/markdown.ts` currently exposes the raw session file too late and never names the backend format.
- `src/config/verbosity.ts` currently uses four user-facing preset names; the redesign goal is two clear modes without losing retrieval depth.
- Several parsers flatten or normalize data before the receiver sees it:
  - `codex` prefers merged conversation messages and grouped tool summaries over raw record-type context.
  - `cursor` and `droid` inherit Anthropic-style tool extraction but do not expose transcript completeness warnings.
  - `cline`-family parsers ignore companion files even though first-party docs say they matter for recovery and checkpoints.
  - `opencode`, `gemini`, `kiro`, and `antigravity` all have backend/variant questions that the current handoff cannot signal.

## File map

- `01-claude.md`
- `02-codex.md`
- `03-copilot.md`
- `04-gemini.md`
- `05-opencode.md`
- `06-droid.md`
- `07-cursor.md`
- `08-amp.md`
- `09-kiro.md`
- `10-crush.md`
- `11-cline.md`
- `12-roo-code.md`
- `13-kilo-code.md`
- `14-antigravity.md`
- `15-kimi.md`
- `16-qwen-code.md`
- `99-open-questions.md`

## Sources

- Local repo anchors: `src/config/verbosity.ts`, `src/utils/markdown.ts`, `src/utils/resume.ts`, `src/parsers/*.ts` (read 2026-04-15)
- Canonical tool list: `src/types/tool-names.ts` (read 2026-04-15)
- Mission brief and context docs in `docs/parser-documentation/` (read 2026-04-15)

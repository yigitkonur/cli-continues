# Message Schema Overview

Access date: 2026-04-15

This folder documents raw conversation/message storage, not just what `continues` currently renders. The highest-risk finding is that several parsers are anchored to older or narrower storage models than the current upstream tools.

## Highest-Risk Mismatches

| Tool | Risk | Why it matters |
|---|---|---|
| Gemini | High | The official `google-gemini/gemini-cli` code now writes append-only JSONL chat records with metadata, `$set`, and `$rewindTo`, but `src/parsers/gemini.ts` still assumes the older monolithic `session-*.json` shape. Assistant-message coverage and trimming can be materially wrong on current installs. |
| Qwen Code | High | The official `QwenLM/qwen-code` code documents `~/.qwen/tmp/<project_id>/chats/*.jsonl`, while `src/parsers/qwen-code.ts` looks under `~/.qwen/projects/*/chats/`. The parser may simply miss current sessions. |
| Antigravity | High | The current parser assumes JSON/JSONL records under `.gemini/antigravity/code_tracker/`, but the local install stores binary `.pb` files under `.gemini/antigravity/conversations/`. Current assistant-message assumptions are likely invalid. |
| Kimi | High | Official Kimi CLI code uses `context.jsonl`, `wire.jsonl`, and `state.json`; the parser reads `context.jsonl` plus optional legacy `metadata.json` and ignores `wire.jsonl`/`state.json`. In sampled local sessions, `context.jsonl` was empty while `wire.jsonl` had usable chronology. |
| OpenCode | Medium | The official schema stores assistant turns as a message row plus structured part rows (`text`, `tool`, `reasoning`, `step-start`, `step-finish`, `patch`, `compaction`, etc.). `src/parsers/opencode.ts` flattens only text parts into conversation messages, which hides assistant step boundaries and tool/result structure. |
| Copilot | Medium | GitHub documents both raw session files and SQLite indexing. The parser only consumes `events.jsonl`, ignores the global `session-store.db`, and drops session directories that only expose newer `session.db` artifacts. |
| Cursor | Medium | The parser assumes Anthropic-style tool blocks and token fields may exist in transcript JSONL, but sampled local transcripts were text-only, and Cursor forum feedback suggests tool-use data is not always fully preserved. |
| Kilo Code | Medium | First-party issue evidence supports legacy `ui_messages.json` task storage, but the official repo also contains a newer `kilo.db`/OpenCode-style persistence layer. The current parser appears tied to the legacy extension path only. |

## Assistant-Message Coverage Risks

- Documented fact: Claude, Codex, Copilot, Gemini, OpenCode, Droid, Amp, Crush, Cline, Roo Code, Kimi, and Qwen all separate assistant turns from user turns in raw storage, but not always as one-record-per-turn.
- Observed example: Claude and Droid frequently store tool results as `user` records containing `tool_result` blocks. Assistant text and assistant tool use are different records. Any naive “all user records are human turns” rule inflates recent-message tails and can hide assistant output.
- Documented fact: Current Gemini and Qwen schemas are append-only JSONL with non-message records (`$set`, `$rewindTo`, `system`, compaction payloads). Message trimming must reconstruct effective history first.
- Inference: Any cross-tool “last N lines” policy is unsafe. Recent-message trimming needs tool-specific reconstruction before truncation.

## Recent-Message Trimming Risks

- `src/parsers/codex.ts` intentionally prefers `response_item` over `event_msg`, but its “balanced tail” still discards older assistant-only spans once it backs up to the last user turn.
- `src/parsers/claude.ts` is directionally correct to filter tool-result-only user entries, but it still trims after a tool-specific conversational filter, which can omit adjacent assistant tool-use context.
- `src/parsers/opencode.ts`, `src/parsers/amp.ts`, and `src/parsers/kiro.ts` flatten message text without preserving assistant step/tool boundaries, so “recent conversation” can look simpler than the raw schema actually is.
- `src/parsers/cursor.ts` and `src/parsers/copilot.ts` assume assistant messages always have enough text to stand alone, yet both tools can emit assistant turns that are mostly tool metadata.

## Design Implications For `continues`

- Separate “storage pointer” from “recent conversation.” The handoff should always expose raw path, format, and reconstruction notes first.
- Reconstruct before trimming for Gemini, Qwen Code, Codex, Claude, and any tree/append-only format.
- Distinguish human user input from tool-result carrier messages for Claude, Droid, Amp, and likely related Anthropic-style tools.
- Treat assistant tool activity as first-class conversation structure, not only as side summaries, for OpenCode, Gemini, Qwen Code, Copilot, and Codex.
- Surface storage-version uncertainty explicitly for Kiro, Antigravity, Cursor, and Kilo Code instead of pretending the parser assumptions are settled.

## Source Notes

- Documented fact sources are first-party docs/repos where available.
- Observed examples come from local session artifacts on this machine, accessed 2026-04-15.
- Open questions that still need upstream confirmation are collected in `99-open-questions.md`.

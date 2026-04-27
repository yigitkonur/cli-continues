# Codex Parser Comparison: `continues` vs Agentlytics

**Scope:** Codex-only comparison between this repo's parser/docs and Agentlytics' Codex handling, checked against first-party OpenAI Codex docs, repo code, and one first-party discussion.
**Last updated:** 2026-04-15
**Confidence:** High for confirmed code-path differences; Medium where rollout persistence policy may vary by Codex version or event-persistence mode.

## 1. Summary

`continues` and Agentlytics are both partly right and partly incomplete for modern Codex rollouts.

- Agentlytics' main Node adapter at `https://raw.githubusercontent.com/f/agentlytics/master/editors/codex.js` is stronger on turn reconstruction, token deltas, and archived-session discovery.
- `continues` is stronger on modern Codex storage documentation, prompt-hygiene filtering, `apply_patch`/file-write summarization, and on explicitly documenting what its parser still misses.
- Agentlytics' Deno scanner at `https://raw.githubusercontent.com/f/agentlytics/master/mod.ts` appears stale for current Codex rollout files. It assumes a flat top-level chat shape that conflicts with OpenAI's current `session_meta` / `turn_context` / `event_msg` / `response_item` rollout format.
- `continues`' parser at [/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts) has one likely schema bug: it reads `event_msg.token_count` from top-level `input_tokens` / `output_tokens`, while OpenAI's current first-party protocol nests those under `payload.info.last_token_usage` and `payload.info.total_token_usage`.

## 2. Agentlytics parser surface

### Main Node adapter: `editors/codex.js`

Documented from `https://raw.githubusercontent.com/f/agentlytics/master/editors/codex.js` and `https://raw.githubusercontent.com/f/agentlytics/master/cache.js`:

- Storage assumptions:
  - Scans both `CODEX_HOME/sessions` and `CODEX_HOME/archived_sessions` recursively (`codex.js`, lines 11-27, 42-48).
  - Requires first line to be `session_meta` and uses `payload.id`, `payload.cwd`, `payload.source`, `payload.originator`, `payload.cli_version`, and `payload.model_provider` (`codex.js`, lines 76-118).
- Session discovery:
  - Deduplicates by `composerId`, so if the same thread appears in active and archived trees it keeps the first seen file (`codex.js`, lines 11-27).
  - Titles sessions from the first non-bootstrap user `response_item.message` (`codex.js`, lines 83-93).
- Message reconstruction:
  - Uses `turn_context` as turn boundaries and model source (`codex.js`, lines 150-158).
  - Reconstructs user messages from `response_item.message(role=user)` and assistant turns from assistant messages, reasoning summaries, tool calls, and tool outputs (`codex.js`, lines 161-199, 280-320).
  - Emits synthetic assistant content like `[thinking] ...`, `[tool-call: ...]`, and `[tool-result: ...]`.
- Tool-call capture:
  - Captures `function_call`, `custom_tool_call`, and `web_search_call`; captures paired outputs via `call_id`; stores normalized tool calls in `_toolCalls` and later in Agentlytics SQLite `tool_calls` (`codex.js`, lines 187-199, 298-320; `cache.js`, lines 272-290).
- Token/model handling:
  - Reads model from `turn_context` and token events from `event_msg.token_count.info.last_token_usage` / `total_token_usage` with delta recovery (`codex.js`, lines 204-227).
  - Stores per-message `_model`, `_inputTokens`, `_outputTokens`, `_cacheRead` and aggregates them into analytics tables (`cache.js`, lines 293-317).
- Audit-log / summarization implications:
  - Stronger for analytics because it persists normalized messages, models, token totals, and tool call rows in SQLite (`cache.js`, lines 223-319).
  - More lossy for handoff fidelity because raw rollout item types are flattened into synthetic assistant text.

### Deno sandboxed scanner: `mod.ts`

Documented from `https://raw.githubusercontent.com/f/agentlytics/master/mod.ts`:

- It scans `sessions` and `archived_sessions`, but expects the first JSONL line to expose top-level `id`, `instructions`, `created_at`, and `cwd` (`mod.ts`, lines 438-447).
- It counts Codex messages with `obj.type === "message" || obj.role` and looks for `obj.model` on top-level rows (`mod.ts`, lines 430-445).

That shape does not match current first-party Codex rollout files, which OpenAI documents and codes as JSONL lines with top-level `type` plus nested payloads such as `session_meta`, `turn_context`, `event_msg`, `response_item`, and `compacted`. Source: OpenAI rollout recorder and protocol definitions in `codex-rs/rollout/src/recorder.rs`, `codex-rs/protocol/src/protocol.rs`, and `ResponseItem.ts`, accessed 2026-04-15.

## 3. Our parser surface

### Parser implementation

Documented from [/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts):

- Storage assumptions:
  - Scans `CODEX_HOME/sessions` recursively only, not `archived_sessions` ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L29), [codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L36), [codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L93)).
  - Derives session ID and created timestamp from the rollout filename, not from `session_meta.payload.id` ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L76)).
- Session discovery:
  - Uses `session_meta.payload.cwd` and `git.repository_url` / `git.branch` to derive repo metadata ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L103)).
  - Uses the first `event_msg.user_message` encountered in the first 150 lines as session summary seed, with a legacy fallback for older flat `message` rows ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L45)).
- Message reconstruction:
  - Collects `event_msg` and `response_item` separately, then prefers `response_item` if present ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L398)).
  - Keeps only plain user/assistant conversational text in `recentMessages`; explicitly skips system-injected user content starting with `<environment_context>`, `<permissions`, or `# AGENTS.md` ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L419)).
  - Does not inject tool-call/result pseudo-lines into the conversation tail.
- Tool-call capture:
  - Joins `function_call_output` and `custom_tool_call_output` by `call_id` ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L205)).
  - Summarizes `exec_command`, `write_stdin`, MCP reads/listing, `request_user_input`, `update_plan`, `view_image`, general MCP-like tool names, `custom_tool_call` including `apply_patch`, and `web_search_call` ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L221)).
  - Tracks probable file writes from shell redirection and `apply_patch`, and computes diff stats for patches ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L173), [codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L293)).
- Token/model handling:
  - Stores only the first `turn_context.model` into `sessionNotes.model` ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L355)).
  - Reads `token_count` from top-level `payload.input_tokens` / `payload.output_tokens` and optional top-level `reasoning_output_tokens` ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L372)).
- Audit-log / summarization implications:
  - Optimized for concise cross-tool handoff, not full-fidelity analytics.
  - Balanced-tail trimming intentionally avoids long assistant-only tails but can omit older assistant activity before the last user message ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L454)).

### Repo documentation surface

The local Codex docs are materially broader than the implementation:

- Storage docs:
  - [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/02-codex.md)
  - [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/02-codex.md)
  - [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/02-codex.md)
- Message/tool schema docs:
  - [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/02-codex.md)
  - [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/02-codex.md)

Those docs already acknowledge several gaps the parser still has:

- no `archived_sessions` scanning
- no modeling of `compacted`
- no handling of `local_shell_call`, `tool_search_call`, or `tool_search_output`
- no exposure of broader `CODEX_HOME` stores like `history.jsonl`, session index, or SQLite state in the parser output

## 4. Where Agentlytics is stronger

- Archived-session coverage is better in `editors/codex.js` because it scans both active and archived rollout trees, which matches OpenAI's first-party rollout code constants `SESSIONS_SUBDIR` and `ARCHIVED_SESSIONS_SUBDIR`. Sources: `codex.js` lines 11-27; `codex-rs/rollout/src/lib.rs`, lines 17-18.
- Token accounting is better in `editors/codex.js` because it follows OpenAI's current `TokenCountEvent.info.last_token_usage` / `total_token_usage` structure and computes deltas from totals when needed. Sources: `codex.js` lines 204-227; OpenAI `protocol.rs` lines 2074-2158.
- Turn reconstruction is richer in `editors/codex.js` because it folds reasoning summaries and tool call/result previews into assistant turns. That makes its downstream analytics and SQLite cache more audit-friendly than `continues`' plain-text recent-tail handoff. Sources: `codex.js` lines 181-199, 247-257, 280-320; `cache.js` lines 241-319.
- Session analytics are stronger in Agentlytics because `cache.js` normalizes messages, token counts, model usage, and tool calls into queryable tables, while `continues` emits handoff-oriented markdown and lightweight summaries instead. Source: `cache.js` lines 223-319.

## 5. Where our parser/docs are stronger

- The local docs are closer to current first-party Codex storage reality than Agentlytics' public Deno scanner. Our docs explicitly distinguish rollout JSONL, `history.jsonl`, archived sessions, and SQLite-backed state, while `mod.ts` still assumes a flat `first.id` / `first.instructions` / `first.created_at` layout. Sources: local docs listed above; `mod.ts` lines 438-447; OpenAI config docs on `CODEX_HOME`, `history.jsonl`, and `sqlite_home`, accessed 2026-04-15.
- Prompt hygiene is stronger in `continues`. The parser filters not just `<environment_context>` but also `<permissions...>` and injected `# AGENTS.md` blocks from user-message reconstruction ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L425)). Agentlytics only filters `<user_instructions>` and `<environment_context>` (`codex.js`, lines 289-292).
- Patch/file-write summarization is stronger in `continues`. It recognizes `apply_patch`, extracts touched files, preserves diff text, computes diff stats, and also heuristically tracks shell redirection writes ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L173), [codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L293)). Agentlytics stores generic tool args and tool names but does not compute patch diff stats.
- The docs are more self-auditing. `/docs/parser-documentation/.../02-codex.md` repeatedly says where the implementation is incomplete instead of silently implying full coverage. Agentlytics' shipped `mod.ts` and `codex.js` do not annotate their own Codex blind spots in code.

## 6. Confirmed mismatches

### A. Agentlytics `mod.ts` is incompatible with current Codex rollout structure

**Documented:** OpenAI's current rollout format uses `session_meta`, `turn_context`, `event_msg`, `response_item`, and `compacted` as top-level line types, with nested payloads. Sources: OpenAI `recorder.rs`; `protocol.rs`; `ResponseItem.ts`.

**Observed:** `mod.ts` expects top-level `id`, `instructions`, `created_at`, `cwd`, and counts `obj.type === "message" || obj.role` for Codex (`mod.ts`, lines 430-447).

**Conclusion:** `mod.ts` is stale for current Codex JSONL and should not be treated as authoritative parser behavior for modern Codex rollouts.

### B. `continues` misses `archived_sessions`

**Documented:** OpenAI rollout code defines both `sessions` and `archived_sessions`, and Agentlytics `codex.js` scans both. Sources: `codex-rs/rollout/src/lib.rs`, lines 17-18; `codex.js`, lines 11-27.

**Observed:** [/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L29) hardcodes only `.../.codex/sessions`.

**Conclusion:** This is a real discovery gap in `continues`, not just a documentation gap.

### C. `continues` token parsing likely does not match current first-party `token_count`

**Documented:** OpenAI's `TokenCountEvent` is `payload.info`, with `total_token_usage` and `last_token_usage`; token counts are nested there, including `reasoning_output_tokens`. Source: `protocol.rs`, lines 2074-2158.

**Observed:** `continues` reads `payload.input_tokens`, `payload.output_tokens`, and top-level `reasoning_output_tokens` in `event_msg.token_count` ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L372)). The local Zod schema also encodes that flatter assumption in [/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts](/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts#L63).

**Counterpoint:** The local docs mention observed Codex rollouts but do not publish a contradictory raw `token_count` sample.

**Conclusion:** Until a live current rollout proves otherwise, this looks like a genuine parser/schema bug in `continues`.

### D. Both implementations under-capture official response-item variants

**Documented:** OpenAI's generated `ResponseItem` type includes `local_shell_call`, `tool_search_call`, `tool_search_output`, `image_generation_call`, `ghost_snapshot`, and `compaction` in addition to the classic function/custom/web-search items. Source: `ResponseItem.ts`, lines 14-18.

**Observed:**

- `continues` only handles `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, and `web_search_call` as response-item tools ([codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L227), [codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L293), [codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L320)).
- Agentlytics `codex.js` only recognizes `function_call`, `custom_tool_call`, `web_search_call`, and paired outputs (`codex.js`, lines 298-304).

**Conclusion:** Both parsers lag the full first-party response-item surface, though our docs already say so explicitly.

### E. Our docs are ahead of our parser on Codex protocol coverage

**Documented in repo docs:** The local docs explicitly state that `continues` does not yet model `compacted`, `local_shell_call`, `tool_search_call`, or `tool_search_output`, and that `archived_sessions` / SQLite / index files exist.

**Observed in code:** Those gaps are real in the parser.

**Conclusion:** The repo's Codex documentation is currently more accurate than the implementation in several areas.

## 7. Still unresolved

- Whether current real-world Codex rollout files ever duplicate token counters at top level on `event_msg.token_count` in addition to the documented nested `info` object. First-party protocol says nested; a current raw rollout sample would close this decisively.
- Whether every official `ResponseItem` variant in `ResponseItem.ts` is actually persisted to rollout JSONL under current persistence policy, or whether some exist in protocol but are gated by recorder policy. OpenAI's recorder policy code would need a narrower review or a live sample set.
- Whether Agentlytics intends `mod.ts` to remain a supported Codex path or only as a lightweight fallback beside the richer Node adapter.

Open issues are tracked in [99-open-issues.md](/Users/yigitkonur/dev/cli-continues/docs/research/agentlytics-parser-comparison/codex/99-open-issues.md).

## 8. URLs

### Local repo files

- [/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts)
- [/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts](/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts)
- [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/02-codex.md)
- [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/02-codex.md)
- [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/02-codex.md)
- [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/02-codex.md)
- [/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/02-codex.md](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/02-codex.md)

### Agentlytics

- https://raw.githubusercontent.com/f/agentlytics/master/editors/codex.js
- https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
- https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
- https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- https://raw.githubusercontent.com/f/agentlytics/master/cache.js

### First-party OpenAI Codex evidence

- https://developers.openai.com/codex/cli/features
- https://developers.openai.com/codex/config-advanced
- https://developers.openai.com/codex/config-reference
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/lib.rs
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- https://github.com/openai/codex/blob/main/codex-rs/state/src/extract.rs
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts
- https://github.com/openai/codex/discussions/3827

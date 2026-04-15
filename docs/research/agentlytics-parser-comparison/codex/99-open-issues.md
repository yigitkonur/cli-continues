# Open Issues: Codex Parser Comparison

**Scope:** Remaining Codex-specific uncertainties after comparing `continues` and Agentlytics against first-party OpenAI Codex evidence.
**Last updated:** 2026-04-15
**Confidence:** Medium

## 1. Does current `event_msg.token_count` ever flatten token counters at top level?

**Why it matters:** [/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts#L372) and [/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts](/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts#L63) assume `input_tokens`, `output_tokens`, and `reasoning_output_tokens` may appear directly on `payload`.

**What first-party evidence says:** OpenAI's current protocol defines `TokenCountEvent` as:

- `info.total_token_usage`
- `info.last_token_usage`
- each usage object carrying `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`

Source: `https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs` (lines 2074-2158 in the 2026-04-15 read).

**Competing interpretation:** A live rollout from some Codex versions might still include compatibility fields at the top level.

**What would close it:** Inspect a fresh raw rollout JSONL line with `type: "event_msg"` and `payload.type: "token_count"` from a current Codex session.

## 2. Which official `ResponseItem` variants are actually persisted in rollout JSONL today?

**Why it matters:** Both parsers currently ignore some first-party response-item variants, but protocol presence is not identical to guaranteed persistence.

**What first-party evidence says:** OpenAI's generated `ResponseItem` union includes:

- `local_shell_call`
- `tool_search_call`
- `tool_search_output`
- `image_generation_call`
- `ghost_snapshot`
- `compaction`

Source: `https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts`

**Competing interpretation:** The recorder's persistence policy may omit some item types depending on event-persistence mode or rollout policy.

**What would close it:** Review the exact recorder policy code for `is_persisted_response_item` or sample current rollouts that exercise those paths.

## 3. Is Agentlytics `mod.ts` still intended to support modern Codex, or is `editors/codex.js` the real supported path?

**Why it matters:** The repo ships two materially different Codex code paths.

**Observed:**

- `editors/codex.js` understands `session_meta`, `turn_context`, `response_item`, and `event_msg.token_count`.
- `mod.ts` still assumes flat top-level `id`, `instructions`, `created_at`, and `cwd`.

**Inferred risk:** The Deno "sandboxed edition" may underreport or mislabel current Codex sessions even if the full Node path works.

**What would close it:** Agentlytics README or release notes explicitly stating whether `mod.ts`'s Codex support is current, best-effort, or intentionally degraded.

## Sources

- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts
- https://raw.githubusercontent.com/f/agentlytics/master/editors/codex.js
- https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- [/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts](/Users/yigitkonur/dev/cli-continues/src/parsers/codex.ts)
- [/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts](/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts)

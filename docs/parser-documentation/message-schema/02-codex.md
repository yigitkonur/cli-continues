# Codex CLI Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: The official Codex recorder persists rollout files as `.jsonl` under `~/.codex/sessions/YYYY/MM/DD/`, with filenames like `rollout-YYYY-MM-DDTHH-MM-SS-<thread-id>.jsonl`.
- Documented fact: Each persisted line is a `RolloutLine` with a top-level `timestamp` plus a flattened `RolloutItem`.
- Documented fact: Persisted item categories include `session_meta`, `turn_context`, `event_msg`, `response_item`, and `compacted`.
- Observed example: A local rollout file started with `session_meta`, then `event_msg`, `response_item`, `turn_context`, additional `response_item`, and `token_count`/task events.

## Assistant Messages

- Observed example: `response_item` lines with `payload.type: "message"` and `payload.role: "assistant"` are the richest assistant-message source.
- Observed example: Assistant text lives inside `payload.content[]` items of type `output_text` or `text`.
- Observed example: `event_msg` lines can also carry assistant text through `payload.type: "agent_message"` or `payload.type: "assistant_message"`.
- Documented fact: `response_item` also has non-conversational assistant-adjacent entries such as `reasoning` and `ghost_snapshot`.

## User Messages

- Observed example: `response_item` lines with `payload.type: "message"` and `payload.role: "user"` carry user `input_text` parts.
- Observed example: `event_msg` lines with `payload.type: "user_message"` duplicate or summarize the same turn.
- Inference: `response_item` is the better conversational source when present; `event_msg` is a fallback/event stream.

## Ordering, Boundaries, And Compaction

- Documented fact: Rollouts are append-only JSONL; file order is canonical.
- Documented fact: Every line also has its own top-level timestamp.
- Documented fact: `compacted` lines exist in the official protocol.
- Inference: Message reconstruction should prefer `response_item` for user/assistant turns, while still preserving `event_msg` and `compacted` as stateful side records.

## Direct Access

- Inspect a rollout: `jq -c . ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Find compacted records: `rg -n '"type":"compacted"' ~/.codex/sessions`
- Find assistant response items: `rg -n '"role":"assistant"' ~/.codex/sessions/.../rollout-*.jsonl`

## Parser Comparison

- `src/parsers/codex.ts` is right to prefer `response_item` over `event_msg` for recent conversation and to skip system-injected user text like `<environment_context>`.
- The parser does not currently model official `compacted` lines, so any compaction boundary is invisible to downstream handoff logic.
- The current balanced-tail heuristic protects against long assistant-only tails, but it still converts the reconstructed message stream into plain alternating text without exposing line-level item types like `reasoning` or `ghost_snapshot`.

## Sources

- Codex recorder implementation: https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs (accessed 2026-04-15)
- Codex protocol definitions: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs (accessed 2026-04-15)
- Codex state extraction: https://github.com/openai/codex/blob/main/codex-rs/state/src/extract.rs (accessed 2026-04-15)
- Observed local rollout: `~/.codex/sessions/2026/03/22/rollout-2026-03-22T06-04-51-019d15a5-f838-7413-a763-e04a7c2a62da.jsonl` (accessed 2026-04-15)

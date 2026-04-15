# Droid Message Schema

Access date: 2026-04-15

## Raw Schema

- Observed example: Sampled local Droid sessions were stored as JSONL under `~/.factory/sessions/<workspace-slug>/<session-id>.jsonl`, with companion `*.settings.json` files.
- Observed example: Sampled persisted line types included `session_start`, `message`, `compaction_state`, and `todo_state`.
- Documented fact: Factory’s `droid exec --output-format stream-json` emits JSONL runtime events such as `system`, `message`, `tool_call`, `tool_result`, and `completion`.
- Documented fact: Factory hooks expose `transcript_path` values ending in `.jsonl`, plus `session_id` and `cwd`.

## Assistant Messages

- Observed example: Persisted assistant turns appeared as `type: "message"` with `message.role: "assistant"`.
- Observed example: Assistant content used Anthropic-style blocks; sampled assistant blocks included `tool_use` followed by later `text`.
- Documented fact: Runtime `stream-json` assistant message events flatten to fields like `role`, `id`, `text`, `timestamp`, and `session_id`.
- Inference: Factory exposes at least two schemas that matter here: a persisted session log and a runtime exec event stream. They are related but not identical.

## User Messages

- Observed example: Human user turns are persisted as `message.role: "user"` with text blocks.
- Observed example: Tool results are also persisted as `message.role: "user"` lines whose blocks are `tool_result`.
- Documented fact: Runtime `stream-json` emits separate `tool_result` events rather than embedding them in user messages.

## Ordering, Boundaries, And Compaction

- Observed example: Persisted JSONL file order is chronological, and message events also include per-event timestamps.
- Observed example: `compaction_state` carried summary text outside the regular user/assistant message flow.
- Observed example: `todo_state` carried pending/in-progress task state outside the message stream.
- Documented fact: Hook docs expose `PreCompact` and `SessionStart` sources including `compact`.

## Direct Access

- Persisted session log: `jq -c . ~/.factory/sessions/<workspace>/<session>.jsonl`
- Companion settings: `cat ~/.factory/sessions/<workspace>/<session>.settings.json`
- Runtime stream reference: see `droid exec --output-format stream-json`

## Parser Comparison

- `src/parsers/droid.ts` aligns well with the observed persisted JSONL plus `.settings.json` model.
- The parser correctly extracts `compaction_state`, `todo_state`, settings-based token usage, and Anthropic-style assistant/user blocks.
- The main risk is conceptual, not structural: Factory’s public `stream-json` docs describe a flatter runtime event protocol than the persisted session log. Future handoff docs should keep those two surfaces separate.

## Sources

- Factory hooks reference: https://docs.factory.ai/reference/hooks-reference (accessed 2026-04-15)
- Droid exec overview: https://docs.factory.ai/cli/droid-exec/overview (accessed 2026-04-15)
- Observed local session log: `~/.factory/sessions/-Users-yigitkonur-.codex/0dce4686-b414-42b1-a450-4fbe53979e30.jsonl` (accessed 2026-04-15)
- Observed local settings: `~/.factory/sessions/-Users-yigitkonur-.codex/0dce4686-b414-42b1-a450-4fbe53979e30.settings.json` (accessed 2026-04-15)

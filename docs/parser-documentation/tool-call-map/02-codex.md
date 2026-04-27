# Codex CLI

## Raw storage

- Documented fact:
  - OpenAI documents `CODEX_HOME` as the local Codex state root, defaulting to `~/.codex`.
  - The official Codex repo writes rollout session files under `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`.
  - Every persisted JSONL line is a `RolloutLine` with `timestamp` plus a flattened `RolloutItem`.
- Observed example:
  - Local files exist under `~/.codex/sessions/2026/03/24/rollout-...jsonl`.
- Inference:
  - `history.jsonl` in the docs and rollout JSONL under `sessions/` are different persistence layers. The parser is correctly targeting rollout files, not the user-level history log.
- Unresolved uncertainty:
  - The exact persistence policy for every response item type depends on Codex rollout policy flags, not just the schema.

## Tool-call encoding

- Documented fact:
  - Official Codex protocol types include these persisted `response_item` variants: `message`, `reasoning`, `local_shell_call`, `function_call`, `tool_search_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `tool_search_output`, `web_search_call`, `image_generation_call`, `ghost_snapshot`, `compaction`, and `other`.
  - `RolloutItem` top-level variants are `session_meta`, `response_item`, `compacted`, `turn_context`, and `event_msg`.
- Observed example:
  - `function_call` stores exact tool name in `payload.name`, arguments as a JSON string in `payload.arguments`, and join key in `payload.call_id`.
  - `function_call_output` stores the result under the matching `payload.call_id`.
  - `custom_tool_call` is used for `apply_patch`, with the full patch in `payload.input`.
  - `custom_tool_call_output` stores the patch result string in `payload.output`.
- Inference:
  - The authoritative join key is `call_id`, not message order.
- Unresolved uncertainty:
  - Some `function_call_output.output` bodies may be structured JSON objects rather than plain strings; local examples were string bodies.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - Exact tool/function names are upstream-visible: `exec_command`, `write_stdin`, `update_plan`, `spawn_agent`, `read_mcp_resource`, `list_mcp_resources`, `custom_tool_call` with `name: "apply_patch"`, plus response-layer `local_shell_call` and `web_search_call`.
- Observed example:
  - Shell runs were recorded as `function_call` with `name: "exec_command"`.
  - Patch edits were recorded as `custom_tool_call` with `name: "apply_patch"`.
- Inference:
  - `local_shell_call` is a schema-level shell path the current parser should understand separately from `exec_command`.

## What `continues` abstracts away today

- `src/parsers/codex.ts` handles `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, and `web_search_call`.
- It does not currently map `local_shell_call`, `tool_search_call`, or `tool_search_output`, even though those are official persisted response-item types.
- It also buckets exact names into generic categories via `SummaryCollector` and `classifyToolName()`.
- Result: current handoffs lose response-item type distinctions and some future-proofing around newer Codex tool/result carriers.

## Direct-access recipe

```bash
rg -n '"type":"function_call"|"type":"custom_tool_call"|"type":"function_call_output"|"type":"custom_tool_call_output"' \
  ~/.codex/sessions -g '*.jsonl' | head

sed -n '12p;15p;20p;22p' ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-...jsonl \
  | jq -c '{type,payload:{type:.payload.type,name:.payload.name,call_id:.payload.call_id,argKeys:(.payload.arguments|fromjson?|keys? // []),hasInput:(.payload.input!=null)}}'
```

## Sources

- Accessed 2026-04-15: https://developers.openai.com/codex/config-advanced
- Accessed 2026-04-15: https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs
- Accessed 2026-04-15: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- Accessed 2026-04-15: https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts
- Observed locally on 2026-04-15: `~/.codex/sessions/.../rollout-*.jsonl`

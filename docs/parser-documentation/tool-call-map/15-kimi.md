# Kimi CLI

## Raw storage

- Documented fact:
  - The official Kimi CLI repo creates sessions under `~/.kimi/sessions/<workdir-hash>/<session-id>/`.
  - Each session directory has a `context.jsonl` history file and a `wire.jsonl` log file.
  - `context.jsonl` is append-only and can also contain special sentinel records `_system_prompt`, `_usage`, and `_checkpoint`.
  - `wire.jsonl` starts with a metadata line and then timestamped wire-message records.
- Observed example:
  - Local Kimi session directories match the `~/.kimi/sessions/<hash>/<session-id>/` pattern.
  - On this machine, sampled `context.jsonl` files were zero bytes, while `wire.jsonl` files were non-empty and began with a metadata header plus `TurnBegin` records.
- Inference:
  - `wire.jsonl` is important operational state, not just an optional side log.
- Unresolved uncertainty:
  - The exact conditions under which Kimi flushes full history into `context.jsonl` versus only writing `wire.jsonl` were not determined from the inspected sources.

## Tool-call encoding

- Documented fact:
  - Official `kosong.message.Message` fields are `role`, `content`, `tool_calls`, `tool_call_id`, and `partial`.
  - `tool_calls[]` items use `type: "function"`, `id`, and `function.{name,arguments}`.
  - Thought blocks are serialized as content parts with `type: "think"` and `think`; optional `encrypted` also exists.
  - `_usage` records store `token_count`.
- Observed example:
  - Local `wire.jsonl` records had a metadata header and timestamped message envelopes, but no local populated `context.jsonl` sample with tool calls was available.
- Inference:
  - The parser’s assumption that Kimi tool calls look like OpenAI-style `tool_calls[].function.name` is supported by the official message model.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - Exact tool/function names are preserved in `tool_calls[].function.name`.
  - Tool arguments are persisted as a JSON string in `tool_calls[].function.arguments`.
- Unresolved uncertainty:
  - No populated local `context.jsonl` example was available to enumerate actual built-in Kimi tool names in use.

## What `continues` abstracts away today

- `src/parsers/kimi.ts` reads only `context.jsonl`.
- Local evidence on this machine suggests that can miss real sessions when `context.jsonl` is empty but `wire.jsonl` is populated.
- The parser also normalizes exact tool names and ignores `wire.jsonl` entirely.

## Direct-access recipe

```bash
find ~/.kimi/sessions -name context.jsonl -o -name wire.jsonl | head -n 20

sed -n '1,8p' ~/.kimi/sessions/<hash>/<session-id>/wire.jsonl \
  | jq -c '{keys:(keys|sort),type,messageKeys:(.message|keys? // []),messageType:(.message.type? // null)}'
```

## Sources

- Accessed 2026-04-15: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py
- Accessed 2026-04-15: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/soul/context.py
- Accessed 2026-04-15: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py
- Accessed 2026-04-15: https://github.com/MoonshotAI/kimi-cli/blob/main/packages/kosong/src/kosong/message.py
- Observed locally on 2026-04-15: `~/.kimi/sessions/...`

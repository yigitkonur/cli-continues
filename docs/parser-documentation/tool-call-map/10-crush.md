# Crush

## Raw storage

- Documented fact:
  - The official Crush repo creates SQLite tables `sessions`, `files`, and `messages`.
  - `messages.parts` is a JSON string storing structured content parts.
- Observed example:
  - Local `~/.crush/crush.db` exists on this machine but is currently zero bytes, so no live rows were available for inspection.
- Inference:
  - The current parser’s table names are aligned with the upstream schema, but its data extraction is not.
- Unresolved uncertainty:
  - No populated local Crush database was available to verify current runtime row contents.

## Tool-call encoding

- Documented fact:
  - Upstream `ContentPart` types include `reasoning`, `text`, `image_url`, `binary`, `tool_call`, `tool_result`, and `finish`.
  - Upstream `ToolCall` fields are `id`, `name`, `input`, `provider_executed`, and `finished`.
  - Upstream `ToolResult` fields are `tool_call_id`, `name`, `content`, `data`, `mime_type`, `metadata`, and `is_error`.
  - Upstream `MessageRole` includes `assistant`, `user`, `system`, and `tool`.
- Inference:
  - Crush preserves exact tool call and result structure inside `messages.parts`; it is not just plain assistant/user text.

## Write, edit, delete, search, MCP, shell

- Unresolved uncertainty:
  - No populated local sample was available to enumerate current exact built-in tool names used by Crush agents.
- Inference:
  - Even without tool-name enumeration, the upstream `tool_call` / `tool_result` part types clearly exceed the fidelity of the current parser.

## What `continues` abstracts away today

- `src/parsers/crush.ts` extracts plain text from `messages.parts` and ignores structured `tool_call` / `tool_result` parts entirely.
- That drops exact upstream names, arguments, provider-executed flags, MIME/data metadata, and error state.

## Direct-access recipe

```bash
sqlite3 ~/.crush/crush.db \
  "select role, parts from messages where parts like '%tool_call%' limit 5;"
```

## Sources

- Accessed 2026-04-15: https://github.com/charmbracelet/crush/blob/main/internal/db/migrations/20250424200609_initial.sql
- Accessed 2026-04-15: https://github.com/charmbracelet/crush/blob/main/internal/db/models.go
- Accessed 2026-04-15: https://github.com/charmbracelet/crush/blob/main/internal/message/content.go
- Accessed 2026-04-15: https://github.com/charmbracelet/crush/blob/main/internal/message/message.go
- Observed locally on 2026-04-15: `~/.crush/crush.db` exists but was empty

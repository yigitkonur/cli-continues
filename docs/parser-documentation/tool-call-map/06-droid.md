# Factory Droid

## Raw storage

- Documented fact:
  - Factory documents hook lifecycle events such as `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PreCompact`, and `SubagentStop`.
  - Factory documents custom droids as `subagent_type` targets for the `Task` tool.
  - Factory does not publish a first-party session-file schema reference.
- Observed example:
  - Local Droid sessions live under `~/.factory/sessions/<workspace-slug>/<session-id>.jsonl`.
  - Companion settings exist as `~/.factory/sessions/<workspace-slug>/<session-id>.settings.json`.
- Inference:
  - The raw event log is the authoritative source for tool-call mapping; docs mainly confirm lifecycle concepts, not file layout.
- Unresolved uncertainty:
  - No first-party public reference was found for every top-level JSONL event field.

## Tool-call encoding

- Observed example:
  - Local Droid message events look like `{ "type": "message", "id": "...", "timestamp": "...", "message": { "role": "...", "content": [...] } }`.
  - Assistant `message.content[]` blocks use Anthropic-style `tool_use` objects with exact names like `TodoWrite`, `Glob`, and `Read`.
  - User reply events return matching `tool_result` blocks with `tool_use_id`.
  - Assistant events can also carry extra top-level fields like `openaiEncryptedContent` and `openaiReasoningId`.
- Documented fact:
  - Factory hook examples show tool payloads as structured JSON, for example reading `.tool_input.command` in a `PreToolUse` hook.
- Inference:
  - Droid’s persisted message format is Anthropic-like for tool I/O, but the session envelope adds Droid/OpenAI-specific side metadata.

## Write, edit, delete, search, MCP, shell

- Observed example:
  - Exact names observed locally included `TodoWrite`, `Glob`, and `Read`.
  - Multiple `tool_use` blocks can appear in the same assistant message.
- Inference:
  - The same shared Anthropic extraction path used for Claude works for block pairing, but it should not discard Droid-specific top-level metadata.

## What `continues` abstracts away today

- `src/parsers/droid.ts` converts Droid events into the shared `extractAnthropicToolData()` helper.
- That helper only consumes block-level `tool_use` and `tool_result` data.
- It does not preserve Droid-specific top-level fields like `openaiEncryptedContent`, `openaiReasoningId`, or any richer future metadata outside the block array.
- As elsewhere, exact tool names are then normalized into broad categories by `tool-names.ts`.

## Direct-access recipe

```bash
rg -n '"tool_use"|"tool_result"' ~/.factory/sessions -g '*.jsonl' | head

sed -n '3p;5p' ~/.factory/sessions/<workspace-slug>/<session-id>.jsonl \
  | jq -c '{type,id,msgRole:.message.role,content:[.message.content[]|{type,name,id,tool_use_id,inputKeys:(.input|keys? // [])}],extraKeys:(keys - ["type","id","timestamp","message","parentId"])}'
```

## Sources

- Accessed 2026-04-15: https://docs.factory.ai/cli/configuration/hooks-guide
- Accessed 2026-04-15: https://docs.factory.ai/cli/configuration/custom-droids
- Accessed 2026-04-15: https://docs.factory.ai/guides/power-user/memory-management
- Observed locally on 2026-04-15: `~/.factory/sessions/.../*.jsonl`

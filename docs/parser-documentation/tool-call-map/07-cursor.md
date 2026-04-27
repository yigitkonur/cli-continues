# Cursor

## Raw storage

- Documented fact:
  - First-party Cursor staff refer to “the JSONL transcript files” for agent chats.
  - In an official forum reply, Cursor staff state that these JSONL transcript files intentionally include tool call inputs but do not include tool call outputs.
- Observed example:
  - Local Cursor agent transcripts live under `~/.cursor/projects/<project-slug>/agent-transcripts/<session-id>.jsonl`.
  - Sampled local transcript lines only contained `role` plus `message.content[]` text blocks.
- Inference:
  - Cursor transcript fidelity is intentionally asymmetric: inputs are eligible for persistence; outputs are intentionally excluded because they can be large.
- Unresolved uncertainty:
  - Local sampled transcripts did not include any persisted tool input blocks, so exact per-version on-disk representation still needs more examples.

## Tool-call encoding

- Documented fact:
  - Cursor staff say JSONL transcript files include “tool call inputs (tool name + arguments)” but intentionally omit tool call outputs.
  - Cursor staff recommend `postToolUse` hooks if users need full output logging.
- Observed example:
  - On this machine, inspected transcript lines were plain message text only.
- Inference:
  - The transcript backend is not Anthropic-complete. Even when tool inputs exist, tool outputs are intentionally absent.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - Tool outputs are intentionally not persisted in transcript JSONL.
- Inference:
  - Any write/edit/delete/search/shell classification from Cursor transcripts should be treated as input-side only unless a separate hook log is consulted.

## What `continues` abstracts away today

- `src/parsers/cursor.ts` currently reuses `extractAnthropicToolData()`, which assumes Anthropic-style `tool_use`/`tool_result` pairing.
- That is a poor fit for first-party Cursor guidance, because Cursor intentionally omits tool outputs from transcript JSONL.
- Result: current summaries can only ever be partial, and they may look more complete than the raw source actually is.

## Direct-access recipe

```bash
find ~/.cursor/projects -path '*/agent-transcripts/*.jsonl' | head

jq -c '{role,content:[.message.content[]?|{type,name,id,inputKeys:(.input|keys? // [])}]}' \
  ~/.cursor/projects/<project>/agent-transcripts/<session>.jsonl | head
```

## Sources

- Accessed 2026-04-15: https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311
- Accessed 2026-04-15: https://forum.cursor.com/t/jsonl-format-should-fully-record-the-tool-use-information/154777
- Observed locally on 2026-04-15: `~/.cursor/projects/.../agent-transcripts/*.jsonl`

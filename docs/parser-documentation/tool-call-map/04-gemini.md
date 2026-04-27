# Gemini CLI

## Raw storage

- Documented fact:
  - The current official Gemini CLI repo writes chat recordings in `chats/` and uses JSONL records with metadata lines, `$set` metadata updates, `$rewindTo` rewind markers, and append-only message records.
  - `ToolCallRecord` and `MessageRecord` are official persisted types in the repo.
- Observed example:
  - This machine still has legacy Gemini session files under `~/.gemini/tmp/<project>/chats/session-*.json`.
  - Those local files are JSON objects with a `.messages[]` array, not JSONL append logs.
- Inference:
  - Gemini is in active storage migration: legacy `.json` session objects still exist in the wild, while the current repo has moved to JSONL append logs.
- Unresolved uncertainty:
  - Exactly which released Gemini CLI versions switched from legacy `.json` to JSONL was not verified.

## Tool-call encoding

- Documented fact:
  - Official `ToolCallRecord` fields are `id`, `name`, `args`, `result`, `status`, `timestamp`, `agentId`, `displayName`, `description`, `resultDisplay`, and `renderOutputAsMarkdown`.
  - Official `MessageRecord` type `gemini` can also carry `toolCalls`, `thoughts`, `tokens`, and `model`.
- Observed example:
  - Local tool calls preserve exact upstream names such as `list_directory`, `ask_user`, `run_shell_command`, `read_file`, and `write_file`.
  - Arguments are stored under `toolCalls[].args`.
  - Results live under `toolCalls[].result[]?.functionResponse?.response.output`.
  - Rich write/edit output lives under `toolCalls[].resultDisplay` with keys like `fileName`, `filePath`, `fileDiff`, `originalContent`, `newContent`, `diffStat`, and `isNewFile`.
- Inference:
  - Gemini’s raw storage already distinguishes “just a textual result” from “file mutation with diff object,” and that distinction should survive into handoffs.
- Unresolved uncertainty:
  - A universal delete-only tool name was not observed in the inspected samples.

## Write, edit, delete, search, MCP, shell

- Observed example:
  - Shell: `run_shell_command`
  - Read: `read_file`
  - Write: `write_file`
  - Search/glob style tools: `list_directory`
- Inference:
  - `continues` should preserve exact tool names instead of only summary categories, because Gemini already gives them cleanly.

## What `continues` abstracts away today

- `src/parsers/gemini.ts` works well on the legacy `.json` format that exists locally, but it does not support the newer JSONL append-log structure from the current official repo.
- It drops `toolCalls[].id`, `displayName`, `description`, `agentId`, and rewind/update semantics.
- `src/types/tool-names.ts` then compresses exact names like `run_shell_command` and `write_file` into generic shell/write buckets.

## Direct-access recipe

```bash
find ~/.gemini -path '*/chats/session-*.json' | head

jq -c '.messages[] | select(.toolCalls!=null) | {type,id,toolCalls:[.toolCalls[]|{name,argKeys:(.args|keys? // []),status,resultDisplayType:(.resultDisplay|type),resultDisplayKeys:(if (.resultDisplay|type)=="object" then (.resultDisplay|keys) else [] end)}]}' \
  ~/.gemini/tmp/<project>/chats/session-*.json | head
```

## Sources

- Accessed 2026-04-15: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts
- Accessed 2026-04-15: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts
- Observed locally on 2026-04-15: `~/.gemini/tmp/.../chats/session-*.json`

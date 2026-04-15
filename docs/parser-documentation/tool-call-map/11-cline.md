# Cline

## Raw storage

- Documented fact:
  - Official Cline docs say task history lives under IDE global storage, with `state/taskHistory.json` as an index and per-task folders under `tasks/<task-id>/`.
  - Each task folder contains `api_conversation_history.json`, `ui_messages.json`, and `task_metadata.json`.
  - The official repo defines `ClineMessage` as the persisted `ui_messages.json` item type.
- Observed example:
  - No local Cline task folders were available on this machine.
- Inference:
  - `ui_messages.json` is a UI/event snapshot, not a faithful low-level tool transcript.

## Tool-call encoding

- Documented fact:
  - `ClineMessage` fields include `ts`, `type`, `ask`, `say`, `text`, `reasoning`, `images`, `files`, `partial`, `commandCompleted`, `lastCheckpointHash`, `isCheckpointCheckedOut`, `isOperationOutsideWorkspace`, `conversationHistoryIndex`, `conversationHistoryDeletedRange`, and `modelInfo`.
  - The official ask/say enums include generic events like `ask: "tool"` and `say: "tool"`, `command_output`, `mcp_server_request_started`, `mcp_server_response`, `codebase_search_result`, and `subtask_result`.
  - Cline docs treat `ui_messages.json` as recoverable task history data, alongside `api_conversation_history.json`.
- Inference:
  - Exact upstream tool function names are not the primary thing `ui_messages.json` preserves. It preserves UI-level asks/says and snapshots.
- Unresolved uncertainty:
  - Without local samples, it is unclear how often `say: "tool"` carries enough detail to infer specific operations beyond the UI layer.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - The schema preserves some operation-adjacent information (`files`, `commandCompleted`, `mcp_server_*`, `codebase_search_result`) but not a clean universal `name + args + result` tool schema.
- Inference:
  - For Cline, “exact upstream tool name” may be unavailable from `ui_messages.json` by design.

## What `continues` abstracts away today

- `src/parsers/cline.ts` chooses the conservative path and emits no tool summaries.
- That is defensible because `ui_messages.json` is not a raw tool log.
- It still leaves information on the floor, though: the parser currently ignores `files`, `reasoning`, `checkpoint`, context-condense/truncation metadata, and generic `say: "tool"` events.

## Direct-access recipe

```bash
find ~/Library/'Application Support'/Code/User/globalStorage/saoudrizwan.claude-dev/tasks -name ui_messages.json 2>/dev/null

jq '.[0] | keys' ~/Library/'Application Support'/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/<task-id>/ui_messages.json
```

## Sources

- Accessed 2026-04-15: https://docs.cline.bot/troubleshooting/task-history-recovery
- Accessed 2026-04-15: https://github.com/cline/cline/blob/main/src/shared/ExtensionMessage.ts

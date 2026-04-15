# Roo Code Access Recipes

## Raw Source

- Documented fact: Roo stores per-task history under `tasks/<task-id>/history_item.json` and maintains a cached `_index.json` under `tasks/`. Source: [Roo TaskHistoryStore](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task-persistence/TaskHistoryStore.ts) (accessed 2026-04-15).
- Documented fact: Roo stores UI messages in `ui_messages.json`, API conversation history in `api_conversation_history.json`, and uses `getTaskDirectoryPath(globalStoragePath, taskId)` to resolve `tasks/<task-id>/`. Sources: [taskMessages.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task-persistence/taskMessages.ts), [apiMessages.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task-persistence/apiMessages.ts), [storage.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/utils/storage.ts) (accessed 2026-04-15).
- Documented fact: Roo supports a configurable `customStoragePath`; the default path is the extension host `globalStoragePath`. Source: `storage.ts`, accessed 2026-04-15.
- User-reported first-party issues discuss `ui_messages.json` bloat and export mismatches, which reinforces that `ui_messages.json` is a raw persisted artifact, not just a cache. Sources: [issue #8690](https://github.com/RooCodeInc/Roo-Code/issues/8690), [issue #9580](https://github.com/RooCodeInc/Roo-Code/issues/9580) (accessed 2026-04-15).

## Retrieval Patterns

### Resolve the default task root

```bash
base=~/Library/'Application Support'/Code/User/globalStorage/rooveterinaryinc.roo-cline
find "$base/tasks" -maxdepth 2 -type f | head -n 30
```

### Inspect the fast index and per-task history

```bash
jq . "$base/tasks/_index.json"
jq . "$base/tasks/<task-id>/history_item.json"
```

### Compare rendered UI and API-level history

```bash
jq '.[9:30]' "$base/tasks/<task-id>/ui_messages.json"
jq '.[9:30]' "$base/tasks/<task-id>/api_conversation_history.json"
```

### Inspect task metadata

```bash
jq . "$base/tasks/<task-id>/task_metadata.json"
```

## Current Parser Comparison

- Current parser treats Roo like a Cline-family tool and reads only `ui_messages.json`.
- Upstream Roo code shows a richer task folder structure and an optional `customStoragePath`. The redesign should mention both the default path and the possibility that the real source of truth has moved.
- For technical continuation, `api_conversation_history.json` is the more important deep-inspection source than `ui_messages.json`.

## Sources

- [Roo TaskHistoryStore](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task-persistence/TaskHistoryStore.ts) (accessed 2026-04-15)
- [Roo taskMessages.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task-persistence/taskMessages.ts) (accessed 2026-04-15)
- [Roo apiMessages.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task-persistence/apiMessages.ts) (accessed 2026-04-15)
- [Roo storage.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/utils/storage.ts) (accessed 2026-04-15)
- [Roo issue #8690](https://github.com/RooCodeInc/Roo-Code/issues/8690) (accessed 2026-04-15)
- [Roo issue #9580](https://github.com/RooCodeInc/Roo-Code/issues/9580) (accessed 2026-04-15)

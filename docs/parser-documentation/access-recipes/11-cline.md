# Cline Access Recipes

## Raw Source

- Documented fact: first-party recovery docs place task history under the extension globalStorage directory, with `taskHistory.json` as the index and per-task folders in `tasks/<task-id>/`. Source: [Task History Recovery Guide](https://docs.cline.bot/troubleshooting/task-history-recovery) (accessed 2026-04-15).
- Documented fact: each task folder contains `api_conversation_history.json`, `ui_messages.json`, and `task_metadata.json`. Same source, accessed 2026-04-15.
- Documented fact: upstream code names the same files and also writes per-task temp exports like `conversation_history_<timestamp>.json` and `.txt`. Source: [cline/cline `src/core/storage/disk.ts`](https://github.com/cline/cline/blob/main/src/core/storage/disk.ts) (accessed 2026-04-15).
- Current parser assumption matches the default VS Code path: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/`.

## Retrieval Patterns

### Find the task root

```bash
base=~/Library/'Application Support'/Code/User/globalStorage/saoudrizwan.claude-dev
find "$base/tasks" -maxdepth 2 -type f | head -n 30
```

### Read rendered UI messages

```bash
jq '.[9:30]' "$base/tasks/<task-id>/ui_messages.json"
```

### Read API-level conversation history

```bash
jq '.[9:30]' "$base/tasks/<task-id>/api_conversation_history.json"
```

### Read task metadata and history index

```bash
jq . "$base/tasks/<task-id>/task_metadata.json"
jq . "$base/taskHistory.json"
```

### Rebuild or inspect task history

```bash
cd "$base/state"
ls taskHistory.backup.*.json
```

## Current Parser Comparison

- Current parser only reads `ui_messages.json`.
- That is not enough for the redesign. `api_conversation_history.json` is the deeper raw source for tool calls and provider-facing message blocks, and `task_metadata.json` carries model/context metadata.
- The pointer block for Cline should include both the task folder and the fact that `taskHistory.json` is only an index.

## Sources

- [Task History Recovery Guide](https://docs.cline.bot/troubleshooting/task-history-recovery) (accessed 2026-04-15)
- [cline/cline `src/core/storage/disk.ts`](https://github.com/cline/cline/blob/main/src/core/storage/disk.ts) (accessed 2026-04-15)


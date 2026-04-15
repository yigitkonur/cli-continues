# Cline

Accessed: 2026-04-15

## Documented Fact

- Official troubleshooting docs still document extension storage under host `globalStorage`:
  - VS Code macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/`
  - VS Code Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\`
  - VS Code Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/`
  - JetBrains equivalents use the same extension ID under JetBrains `globalStorage`
- Documented task data layout:
  - `state/taskHistory.json`
  - `tasks/<task-id>/api_conversation_history.json`
  - `tasks/<task-id>/ui_messages.json`
  - `tasks/<task-id>/task_metadata.json`
- Session/task ID location: the `<task-id>` directory name
- Recovery behavior:
  - `taskHistory.json` is only an index
  - reconstruction scans `tasks/`
- No env-var override for the task storage root was found in the public docs; the effective root comes from the host IDE `globalStorage` path.
- Append/update behavior:
  - `ui_messages.json` and `api_conversation_history.json` are task-local JSON files
  - `taskHistory.json` is rewritten as an index
  - recovery rebuilds the index from task folders

## Observed Example

- Current Cline repo migration code says VS Code global state and secrets are being exported to shared file-backed stores in `~/.cline/data/`.
- The same code explicitly says task data is not yet shared there:
  - task history still lives at `{globalStorageFsPath}/state/taskHistory.json`
  - task folders still live at `{globalStorageFsPath}/tasks/`

## Inference

- For conversation recovery specifically, the old `globalStorage/.../tasks/` structure is still authoritative today, even though other state is migrating into `~/.cline/data/`.

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/cline.ts` are still substantially aligned for VS Code task discovery.
- Gaps:
  - parser is VS Code-centric and does not surface the documented JetBrains path
  - parser reads only `ui_messages.json`
  - parser ignores `api_conversation_history.json`, `task_metadata.json`, and `state/taskHistory.json`

## Direct Access Recipe

- Task folders:
  - `<globalStorage>/tasks/<task-id>/ui_messages.json`
  - `<globalStorage>/tasks/<task-id>/api_conversation_history.json`
  - `<globalStorage>/tasks/<task-id>/task_metadata.json`
- History index:
  - `<globalStorage>/state/taskHistory.json`

## Sources

- Official docs: https://docs.cline.bot/troubleshooting/task-history-recovery
- Official repo code: https://github.com/cline/cline

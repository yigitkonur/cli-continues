# Cline

## Documented Facts

- First-party Cline docs document global storage roots under VS Code or JetBrains and show the task directory structure:
  - `state/taskHistory.json`
  - `tasks/<task-id>/api_conversation_history.json`
  - `tasks/<task-id>/ui_messages.json`
  - `tasks/<task-id>/task_metadata.json`
  - `checkpoints/<workspace-hash>/.git`
- The same docs say `taskHistory.json` is only an index; the real conversation lives in the per-task folders.

## Observed Example

- `src/parsers/cline.ts` reads only `ui_messages.json` from the task folder.
- `test-fixtures/cline/tasks/test-task-1/ui_messages.json` shows the raw event-array shape with `say` values like `text`, `api_req_started`, `reasoning`, and `completion_result`.

## Inference

- Cline’s pointer block should be task-directory-centric, not transcript-file-centric. The receiver needs `ui_messages.json` first, but it also needs to know companion files and checkpoints exist.

## Unresolved Uncertainty

- The parser currently ignores `api_conversation_history.json`, `task_metadata.json`, and checkpoint data, so full-mode depth is partly aspirational until extraction expands.

## Default-Mode Pointer Block

- `Session`: Cline / `<task-id>`
- `Task dir`: `<globalStorage>/saoudrizwan.claude-dev/tasks/<task-id>/`
- `Primary file`: `ui_messages.json`
- `Backend`: JSON array event log
- `Volume`: `<array-length>` events
- `Quick inspect`: `jq '.[-12:]' <task-dir>/ui_messages.json`

## Full-Mode Pointer Block

- Everything from default mode
- `Companions`: `api_conversation_history.json`, `task_metadata.json`
- `Index`: mention `state/taskHistory.json`
- `Checkpoint store`: mention `checkpoints/<workspace-hash>/.git`
- `Focused retrieval`:
  - `jq 'map(.say) | group_by(.) | map({say: .[0], count: length})' <task-dir>/ui_messages.json`
  - `jq . <task-dir>/task_metadata.json`

## Why This Is Feasible

- `continues` already knows the `ui_messages.json` path; the sibling files are deterministic inside the same task directory.

## Current `continues` Comparison

- Current handoff output only reflects `ui_messages.json` even though first-party recovery docs make it clear that the task directory and checkpoint store are the real recovery surface.

## Sources

- Official docs: https://docs.cline.bot/troubleshooting/task-history-recovery (accessed 2026-04-15)
- Local parser and fixture: `src/parsers/cline.ts`, `test-fixtures/cline/tasks/test-task-1/ui_messages.json` (read 2026-04-15)

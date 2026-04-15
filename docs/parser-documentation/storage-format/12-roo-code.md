# Roo Code

Accessed: 2026-04-15

## Documented Fact

- Roo still stores task messages as JSON files inside `tasks/<task-id>/`:
  - `ui_messages.json`
  - `history_item.json`
  - other task files such as metadata remain task-local
- Roo maintains a task index:
  - `tasks/_index.json`
- Session/task ID location:
  - directory name `<task-id>`
  - mirrored inside `history_item.json`
- Append/update behavior:
  - per-task files are rewritten atomically
  - `_index.json` is debounced and rewritten as a cache/index
  - cross-process consistency is handled with locked writes and reconciliation
- No env-var override for the storage base path was found; the documented override is the extension-level `customStoragePath` setting.

## Observed Example

- Current Roo code supports a `customStoragePath` override. If set and writable, Roo uses that path instead of the default VS Code global storage root.

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/cline.ts` assume a fixed VS Code path under `rooveterinaryinc.roo-cline/tasks/`.
- What still matches:
  - `ui_messages.json` in per-task directories is still real
- Gaps:
  - parser ignores `history_item.json` and `_index.json`
  - parser ignores `customStoragePath`
  - parser does not account for today’s stronger task-history/index model

## Direct Access Recipe

- Default or custom storage base:
  - `<storage-base>/tasks/`
- Inspect:
  - `<storage-base>/tasks/<task-id>/ui_messages.json`
  - `<storage-base>/tasks/<task-id>/history_item.json`
  - `<storage-base>/tasks/_index.json`

## Sources

- Official repo code: https://github.com/RooCodeInc/Roo-Code

# Kilo Code

Accessed: 2026-04-15

## Documented Fact

- Current runtime data root is XDG data for app `kilo`, typically:
  - `~/.local/share/kilo`
- Current DB path:
  - `~/.local/share/kilo/kilo.db`
- DB override:
  - `KILO_DB`
- Current storage format: SQLite
- Current schema lineage is Opencode-derived and session-centric, not VS Code `ui_messages.json`-centric.
- Session-ID location:
  - current runtime sessions live in the SQLite `session` table
  - legacy migrated sessions originate from old VS Code task IDs
- Append/update behavior:
  - current runtime updates happen through mutable SQLite rows
  - the old VS Code task files are legacy import inputs

## Observed Example

- The Kilo repo still contains VS Code legacy-migration code that reads:
  - `context.globalStorageUri/tasks/<task-id>/api_conversation_history.json`
- That code exists specifically to import legacy task folders into the current session model.

## Inference

- The fixed VS Code `tasks/` layout assumed by `continues` is now a migration source, not the primary live store.

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/cline.ts` still treat Kilo like a Cline-family VS Code extension with:
  - `.../globalStorage/kilocode.kilo-code/tasks/`
  - `ui_messages.json`
- Upstream code shows a different present-day reality:
  - XDG data root
  - SQLite `kilo.db`
  - legacy task folders only for migration/import
- Risk: very high. Current Kilo support in `continues` is aimed at historical storage, not the current runtime.

## Direct Access Recipe

- Current DB:
  - `~/.local/share/kilo/kilo.db`
- Legacy migration source, if present:
  - `<vscode-globalStorage>/tasks/<task-id>/api_conversation_history.json`

## Sources

- Official repo code: https://github.com/Kilo-Org/kilocode

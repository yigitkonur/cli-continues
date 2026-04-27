# Crush

Accessed: 2026-04-15

## Documented Fact

- Current default session data directory is project-local `.crush`
- Default session DB path:
  - `<workspace>/.crush/crush.db`
- If Crush starts in a nested directory, it looks for the closest ancestor `.crush` before defaulting to `<workingDir>/.crush`
- Session-DB root override:
  - no env-var override for the live project session DB was found
  - the effective root comes from `data.dir` / default `.crush` resolution
- Current session storage format: SQLite
- Relevant tables from first-party migrations:
  - `sessions`
  - `messages`
  - `files`
- Session-ID location:
  - `sessions.id`
  - regular sessions are UUIDs
  - helper/task sessions can also use derived IDs like `title-<parent>` or tool-call IDs
- Append/update behavior:
  - sessions/messages/files mutate in place via SQL
  - update triggers maintain `updated_at`
  - insert/delete triggers maintain `message_count`

## Documented But Separate Global Paths

- `CRUSH_GLOBAL_CONFIG`
- `CRUSH_CACHE_DIR`
- `CRUSH_GLOBAL_DATA`
- `XDG_DATA_HOME` affects global data/config JSON paths, not the default per-project session DB path

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/crush.ts` assume `~/.crush/crush.db`.
- Upstream code says the live default is workspace-local `.crush/crush.db`.
- Risk: very high. `continues` is currently pointed at the wrong default root for real Crush session databases.

## Direct Access Recipe

- Current project DB:
  - `<repo>/.crush/crush.db`
- Example query:
  - `sqlite3 .crush/crush.db "select id,title,message_count,created_at,updated_at from sessions order by updated_at desc;"`

## Sources

- Official repo code: https://github.com/charmbracelet/crush

# OpenCode

Accessed: 2026-04-15

## Documented Fact

- Data root: XDG data directory for `opencode`, typically `~/.local/share/opencode`
- Root override inputs:
  - `XDG_DATA_HOME` influences the default data root
  - `OPENCODE_DB` overrides the SQLite DB path itself
- Default DB path:
  - `opencode.db`
  - Channel variants may produce `opencode-<channel>.db`
- Format: SQLite for current storage
- Current tables relevant to sessions:
  - `session`
  - `message`
  - `part`
  - `project`
- Session-ID location: `session.id`
- Message linkage:
  - `message.session_id`
  - `part.message_id`
  - `part.session_id`
- Append/update behavior:
  - current runtime is DB-first
  - DB uses WAL mode and normal synchronous mode
  - rows are inserted/updated in place

## Observed Example

- The OpenCode repo still ships migration code for the older file store:
  - `storage/session/<project>/<session>.json`
  - `storage/message/<session-id>/*.json`
  - `storage/part/<message-id>/*.json`
- That older layout is now migration/fallback material, not the primary store.

## Comparison Against `continues`

- Registry: `src/parsers/registry.ts` points users at `~/.local/share/opencode/storage/`, which is now legacy-biased.
- Parser: `src/parsers/opencode.ts` is better than the registry text because it tries SQLite first and only falls back to JSON.
- Gap: the registry omits `opencode.db` and `OPENCODE_DB`, so a user following help text would look in the wrong place for current installs.

## Direct Access Recipe

- Current sessions DB: `~/.local/share/opencode/opencode.db`
- Example query:
  - `sqlite3 ~/.local/share/opencode/opencode.db "select id,title,time_created,time_updated from session order by time_updated desc;"`
- Legacy fallback:
  - `~/.local/share/opencode/storage/session/...`

## Sources

- Official repo code: https://github.com/opencode-ai/opencode

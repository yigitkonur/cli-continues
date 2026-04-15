# OpenCode Access Recipes

## Raw Source

- Documented fact: current upstream OpenCode stores sessions in SQLite tables `session`, `message`, `part`, `todo`, and `session_entry`. Source: [anomalyco/opencode `session.sql.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.sql.ts) (accessed 2026-04-15).
- Documented fact: upstream migration code confirms an older JSON storage tree under `storage/project`, `storage/session`, `storage/message`, `storage/part`, `storage/todo`, `storage/permission`, and `storage/session_share`. Source: [anomalyco/opencode `json-migration.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/storage/json-migration.ts) (accessed 2026-04-15).
- Observed example: this machine has `~/.local/share/opencode/opencode.db`, plus sidecars like `storage/session_diff/`, `tool-output/`, `snapshot/`, `log/`, and `opencode.db-wal`. Observed 2026-04-15.

## Retrieval Patterns

### Discover tables and session rows

```bash
db=~/.local/share/opencode/opencode.db
sqlite3 "$db" '.tables'
sqlite3 "$db" 'SELECT id, project_id, title, directory, time_updated FROM session ORDER BY time_updated DESC LIMIT 20;'
```

### Pull messages 10-30 for one session

```bash
sqlite3 "$db" "
  SELECT m.id, json_extract(m.data,'$.role') AS role, m.time_created
  FROM message m
  WHERE m.session_id = 'ses_...'
  ORDER BY m.time_created, m.id
  LIMIT 21 OFFSET 9;
"
```

### Join message parts to find assistant tool parts and edits

```bash
sqlite3 "$db" "
  SELECT p.message_id, json_extract(m.data,'$.role') AS role,
         json_extract(p.data,'$.type') AS part_type,
         json_extract(p.data,'$.tool') AS tool_name,
         json_extract(p.data,'$.state.status') AS tool_status
  FROM part p
  JOIN message m ON m.id = p.message_id
  WHERE p.session_id = 'ses_...'
  ORDER BY m.time_created, p.id;
"
```

### Fallback JSON tree inspection

```bash
find ~/.local/share/opencode/storage/session -name 'ses_*.json'
find ~/.local/share/opencode/storage/message/ses_... -name 'msg_*.json' | sort
find ~/.local/share/opencode/storage/part/msg_... -name 'prt_*.json' | sort
```

## Current Parser Comparison

- Current parser already supports both SQLite and legacy JSON files, which is good.
- The current handoff still omits deeper tables and sidecars that matter for technical continuation: `session_entry`, `event`, `workspace`, `tool-output`, and `session_diff`.
- For OpenCode, the pointer block should prefer the SQLite DB path plus a one-line `session_id`, because that is the most information-dense raw source.

## Sources

- [anomalyco/opencode `session.sql.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.sql.ts) (accessed 2026-04-15)
- [anomalyco/opencode `json-migration.ts`](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/storage/json-migration.ts) (accessed 2026-04-15)


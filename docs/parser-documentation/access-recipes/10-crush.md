# Crush Access Recipes

## Raw Source

- Documented fact: Crush stores data in a SQLite database named `crush.db`. Source: [charmbracelet/crush `connect.go`](https://github.com/charmbracelet/crush/blob/main/internal/db/connect.go) (accessed 2026-04-15).
- Documented fact: core transcript data lives in `sessions` and `messages`, with message content stored as JSON in the `parts` column. Sources: [sessions.sql](https://github.com/charmbracelet/crush/blob/main/internal/db/sql/sessions.sql), [messages.sql](https://github.com/charmbracelet/crush/blob/main/internal/db/sql/messages.sql), [initial migration](https://github.com/charmbracelet/crush/blob/main/internal/db/migrations/20250424200609_initial.sql) (accessed 2026-04-15).
- Current parser assumption `~/.crush/crush.db` is strongly supported by upstream code.
- Observed example: there is no local `~/.crush/crush.db` on this machine, so the doc below is source-backed but not locally verified here.

## Retrieval Patterns

### Discover schema

```bash
db=~/.crush/crush.db
sqlite3 "$db" '.tables'
sqlite3 "$db" 'PRAGMA table_info(sessions);'
sqlite3 "$db" 'PRAGMA table_info(messages);'
```

### List recent sessions

```bash
sqlite3 "$db" "
  SELECT id, title, updated_at, prompt_tokens, completion_tokens
  FROM sessions
  ORDER BY updated_at DESC
  LIMIT 20;
"
```

### Pull messages 10-30 from one session

```bash
sqlite3 "$db" "
  SELECT id, role, parts, created_at
  FROM messages
  WHERE session_id = '...'
  ORDER BY created_at ASC
  LIMIT 21 OFFSET 9;
"
```

### Extract text from `parts`

```bash
sqlite3 "$db" "
  SELECT json_extract(value,'$.data.text')
  FROM messages, json_each(messages.parts)
  WHERE session_id = '...' AND json_extract(value,'$.type') = 'text';
"
```

## Current Parser Comparison

- Current parser points at the correct DB and core tables.
- The handoff should expose the DB path plus one ready-to-run SQL snippet, because Crush is not line-oriented.
- Current parser does not mention the `files` table from the initial migration; if that table is still in use, it is a likely source for "assistant messages with edits stored" style questions.

## Sources

- [charmbracelet/crush `connect.go`](https://github.com/charmbracelet/crush/blob/main/internal/db/connect.go) (accessed 2026-04-15)
- [charmbracelet/crush `sessions.sql`](https://github.com/charmbracelet/crush/blob/main/internal/db/sql/sessions.sql) (accessed 2026-04-15)
- [charmbracelet/crush `messages.sql`](https://github.com/charmbracelet/crush/blob/main/internal/db/sql/messages.sql) (accessed 2026-04-15)
- [charmbracelet/crush initial migration](https://github.com/charmbracelet/crush/blob/main/internal/db/migrations/20250424200609_initial.sql) (accessed 2026-04-15)


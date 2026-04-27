# Crush Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: Crush persists sessions in SQLite.
- Documented fact: The official migration/schema defines `sessions`, `messages`, and `files` tables.
- Documented fact: The `messages` table stores `role`, `parts`, `model`, timestamps, and related metadata.
- Documented fact: The query layer orders messages by `created_at ASC` for per-session replay.
- Observed example: On this machine, `~/.crush/crush.db` currently exists but is empty, so there was no local populated session example to inspect.

## Assistant Messages

- Documented fact: Assistant turns are stored as rows in `messages` with `role = 'assistant'`.
- Documented fact: Message content lives in the `parts` JSON column rather than in scalar text columns.
- Inference: Assistant-message reconstruction requires parsing `parts`, not just reading one `assistant_response` column.

## User Messages

- Documented fact: User turns are rows in `messages` with `role = 'user'`.
- Documented fact: The official SQL layer also exposes helpers like `ListUserMessagesBySession`.

## Ordering, Boundaries, And Summaries

- Documented fact: Message order is `created_at ASC`.
- Documented fact: The schema includes richer session-level metadata than the current parser uses, including prompt/completion token counts and, in the SQL layer, summary/todo-related fields.
- Unresolved uncertainty: I did not find a first-party public example of the exact `parts` JSON payload for a current populated database in this audit.

## Direct Access

- Inspect schema: `sqlite3 ~/.crush/crush.db '.schema sessions' '.schema messages'`
- List messages for a session: `sqlite3 ~/.crush/crush.db 'SELECT role, parts, created_at FROM messages WHERE session_id = ... ORDER BY created_at ASC'`

## Parser Comparison

- `src/parsers/crush.ts` is directionally aligned with the official schema: it expects SQLite, session rows, message rows, and a `parts` JSON column.
- The parser only extracts plain text from `parts` and ignores other official fields such as `provider`, `finished_at`, and broader session metadata.
- Because the local DB was empty, current parser assumptions about the exact `parts` payload remain code-backed rather than locally observed.

## Sources

- Crush initial migration: https://github.com/charmbracelet/crush/blob/main/internal/db/migrations/20250424200609_initial.sql (accessed 2026-04-15)
- Crush session queries: https://github.com/charmbracelet/crush/blob/main/internal/db/sql/sessions.sql (accessed 2026-04-15)
- Crush message queries: https://github.com/charmbracelet/crush/blob/main/internal/db/sql/messages.sql (accessed 2026-04-15)
- Observed local DB path: `~/.crush/crush.db` (accessed 2026-04-15)

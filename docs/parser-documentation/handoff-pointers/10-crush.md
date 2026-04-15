# Crush

## Documented Facts

- First-party Crush repo code persists sessions and messages in SQLite tables named `sessions` and `messages`.
- The CLI session commands use session IDs, can list/show/delete/rename sessions, and operate on the database opened from the configured data directory.

## Observed Example

- `src/parsers/crush.ts` assumes the default DB path is `~/.crush/crush.db` and queries `sessions` plus `messages.parts`.
- The parser already uses row counts from SQLite and treats `parts` as JSON arrays of typed message fragments.

## Inference

- Crush should have a database-first pointer block. Unlike JSONL tools, the meaningful identifier is `crush.db + session_id`.

## Unresolved Uncertainty

- The public docs page that would have been convenient to cite returned a `410` during scraping, so the strongest evidence in this pass is the first-party repo code rather than docs prose.
- The exact default data directory can still be user-overridden with CLI config, so the pointer should expose the resolved DB path from the local installation when possible.

## Default-Mode Pointer Block

- `Session`: Crush / `<session-id>`
- `Primary source`: `<data-dir>/crush.db`
- `Backend`: SQLite
- `Scope key`: `session_id=<session-id>`
- `Volume`: `<message-row-count>` rows
- `Quick inspect`:
  - `sqlite3 <db> '.tables'`
  - `sqlite3 <db> "select role, created_at from messages where session_id='<session-id>' order by created_at;" | head`

## Full-Mode Pointer Block

- Everything from default mode
- `Tables`: highlight `sessions` and `messages`
- `Shape note`: `messages.parts` is JSON and must be decoded to recover text blocks
- `Focused retrieval`:
  - `sqlite3 <db> "select * from sessions where id='<session-id>';" -json`
  - `sqlite3 <db> "select role, parts, model, provider, created_at from messages where session_id='<session-id>' order by created_at;" -json`

## Why This Is Feasible

- `continues` already queries the DB and knows the session ID plus message row count.
- The extra full-mode SQL recipes are directly aligned with the parser’s current extraction path.

## Current `continues` Comparison

- Current handoff output reduces Crush to recent messages and token counts, but the real raw source is a relational store with session/message tables and JSON `parts`.
- The pointer block should make that DB reality explicit at the top.

## Sources

- First-party repo code: `charmbracelet/crush` files `internal/db/sql/sessions.sql`, `internal/db/sql/messages.sql`, and `internal/cmd/session.go` (read 2026-04-15)
- Local parser: `src/parsers/crush.ts` (read 2026-04-15)

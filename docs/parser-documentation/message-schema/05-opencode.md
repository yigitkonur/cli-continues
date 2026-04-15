# OpenCode Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: Current OpenCode persistence is SQLite-first, with `session`, `message`, and `part` tables in `opencode.db`.
- Documented fact: OpenCode still supports migration from legacy JSON storage under `storage/project`, `storage/session`, `storage/message`, `storage/part`, and related directories.
- Observed example: The local `opencode.db` had `session`, `message`, `part`, `session_share`, `todo`, and related tables.
- Observed example: `message.data` rows stored structured JSON with fields like `role`, `time`, `agent`, `model`, `variant`, and summary metadata.
- Observed example: `part.data` rows stored structured JSON with `type` values such as `text`, `tool`, `step-start`, and `step-finish`.

## Assistant Messages

- Documented fact: Assistant message rows use `role: "assistant"` in `message.data`.
- Documented fact: Assistant turns are completed by associated `part` rows, not by the message row alone.
- Documented fact: Official assistant-part types include `text`, `tool`, `reasoning`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `retry`, `compaction`, and `subtask`.
- Observed example: Sampled local assistant parts included `step-start`, `text`, `tool`, and `step-finish`.

## User Messages

- Documented fact: User message rows use `role: "user"` and can include summary metadata plus text/file parts.
- Documented fact: User messages can carry structured diff summaries in `summary.diffs`.

## Ordering, Boundaries, And Compaction

- Documented fact: Messages are ordered by `time_created`, and parts are ordered by `message_id` plus creation/id order.
- Documented fact: Compaction is first-class in the schema: assistant messages can be marked as summary messages, and `compaction` parts exist.
- Documented fact: Session-level summary stats also live on the `session` row as additions/deletions/files/diffs.
- Inference: Assistant message boundaries are “message row + ordered part rows,” not one row = one readable turn.

## Direct Access

- Session schema: `sqlite3 ~/.local/share/opencode/opencode.db '.schema session' '.schema message' '.schema part'`
- Message rows: `sqlite3 ~/.local/share/opencode/opencode.db 'SELECT id, session_id, data FROM message WHERE session_id = ... ORDER BY time_created'`
- Part rows: `sqlite3 ~/.local/share/opencode/opencode.db 'SELECT message_id, data FROM part WHERE session_id = ... ORDER BY time_created'`

## Parser Comparison

- `src/parsers/opencode.ts` correctly knows OpenCode has both SQLite and legacy JSON storage.
- The parser flattens only `text` parts into conversation messages, so assistant step boundaries, reasoning parts, tool parts, patch parts, and compaction parts are all omitted from recent conversation.
- The registry points users at `~/.local/share/opencode/storage/`, but the current primary store on this machine is `~/.local/share/opencode/opencode.db`. A handoff pointer should prefer the DB path when it exists.

## Sources

- OpenCode session SQL schema: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.sql.ts (accessed 2026-04-15)
- OpenCode message schema: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts (accessed 2026-04-15)
- OpenCode session logic: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/index.ts (accessed 2026-04-15)
- OpenCode compaction logic: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts (accessed 2026-04-15)
- Observed local DB: `~/.local/share/opencode/opencode.db` (accessed 2026-04-15)

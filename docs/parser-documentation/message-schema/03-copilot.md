# GitHub Copilot CLI Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: GitHub documents `~/.copilot/session-state/` as the directory containing per-session history files and `~/.copilot/session-store.db` as the SQLite session store.
- Documented fact: Per-session directories store `events.jsonl` plus workspace artifacts; the global SQLite store is a subset/index of the raw session files.
- Documented fact: The raw session data includes prompts, Copilot responses, tools used, and file modifications.
- Observed example: Local session directories contained `workspace.yaml`, `events.jsonl`, `vscode.metadata.json`, and in some cases a per-session `session.db`.
- Observed example: The global `session-store.db` contained `sessions`, `turns`, and `session_files` tables.

## Assistant Messages

- Observed example: `events.jsonl` included `assistant.turn_start` and `assistant.message` events.
- Observed example: `assistant.message.data` contained `messageId`, `content`, `toolRequests`, `interactionId`, `reasoningOpaque`, `reasoningText`, and `outputTokens`.
- Observed example: Tool execution details also appeared as separate `tool.execution_start` events with `toolName`, `arguments`, and `toolCallId`.
- Observed example: The SQLite `turns` table stored `assistant_response` per `turn_index`.

## User Messages

- Observed example: `user.message.data` contained `content`, `transformedContent`, `source`, `attachments`, and `interactionId`.
- Observed example: The SQLite `turns` table stored `user_message` alongside `assistant_response`.

## Ordering, Boundaries, And Indexing

- Documented fact: Raw session files are written incrementally during a session and on session end.
- Observed example: `events.jsonl` is an append-only event stream, not a normalized turns array.
- Observed example: The global `turns` table normalizes ordering with `turn_index`, and `session_files` associates modified files to a `turn_index`.
- Inference: `events.jsonl` is the richer raw source; the SQLite store is a searchable summary/index, not the full fidelity stream.

## Direct Access

- Per-session raw log: `jq -c . ~/.copilot/session-state/<session-id>/events.jsonl`
- Global index schema: `sqlite3 ~/.copilot/session-store.db '.schema sessions' '.schema turns' '.schema session_files'`
- List indexed turns: `sqlite3 ~/.copilot/session-store.db 'SELECT * FROM turns WHERE session_id = ... ORDER BY turn_index'`

## Parser Comparison

- `src/parsers/copilot.ts` correctly targets `events.jsonl` and `workspace.yaml` for the raw conversation path described in the docs.
- The parser currently ignores explicit `tool.execution_*` events and only summarizes tool activity from `assistant.message.data.toolRequests`.
- The parser also ignores the global `session-store.db`, even though GitHub documents it as the maintained cross-session index.
- Observed local directories with `session.db` but no `events.jsonl` suggest the parser may miss some newer or incomplete session variants entirely because it filters out sessions with zero raw-event bytes.

## Sources

- GitHub Copilot CLI session data docs: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle (accessed 2026-04-15)
- GitHub Copilot CLI config dir reference: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference (accessed 2026-04-15)
- Observed local event log: `~/.copilot/session-state/005a2626-fdd3-4393-85ab-1a4050afb71d/events.jsonl` (accessed 2026-04-15)
- Observed local session store: `~/.copilot/session-store.db` (accessed 2026-04-15)

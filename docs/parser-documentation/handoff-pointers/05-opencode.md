# OpenCode

## Documented Facts

- First-party OpenCode issue threads confirm two real storage backends in the wild:
  - SQLite at `~/.local/share/opencode/opencode.db`
  - legacy JSON under `~/.local/share/opencode/storage/`
- First-party code shows session/project/message/part data living under `storage/` for JSON mode and a channel-aware SQLite DB for newer builds.
- The same issue threads document JSON-to-SQLite migration drift where old JSON session files can remain on disk even when SQLite becomes the live source.

## Observed Example

- `src/parsers/opencode.ts` explicitly tries SQLite first and falls back to JSON files.
- The parser already models both layouts:
  - SQLite tables for `session`, `project`, `message`, and `part`
  - JSON files under `storage/session/`, `storage/project/`, `storage/message/`, and `storage/part/`

## Inference

- OpenCode needs a variant-aware pointer block every time. The receiver needs to know whether the handoff is grounded in SQLite or legacy JSON, because the deep-access recipe is completely different.

## Unresolved Uncertainty

- Channel-specific DB filenames and migration state can vary by installation. The pointer block should expose the actual resolved backend path, not a guessed default.

## Default-Mode Pointer Block

- `Session`: OpenCode / `<session-id>`
- `Storage variant`: `sqlite` or `legacy-json`
- `Primary source`:
  - SQLite: `<data-dir>/opencode.db`
  - JSON: `<data-dir>/storage/session/<project>/<session>.json`
- `Backend`: `SQLite` or `JSON file tree`
- `Volume`: message row count or message file count
- `Quick inspect`:
  - SQLite: `sqlite3 <db> '.tables'`
  - JSON: `jq . <session>.json`

## Full-Mode Pointer Block

- Everything from default mode
- `Related artifacts`:
  - SQLite: note `session`, `project`, `message`, `part`
  - JSON: explicit `project/`, `message/<session-id>/`, `part/<message-id>/`
- `Migration note`: say whether stale JSON storage also exists when SQLite is active
- `Focused retrieval`:
  - SQLite:
    - `sqlite3 <db> "select id, title, time_updated from session where id='<session-id>';"`
    - `sqlite3 <db> "select id, data from message where session_id='<session-id>' order by time_created;"`
  - JSON:
    - `find <storage>/message/<session-id> -maxdepth 1 -type f | sort`
    - `find <storage>/part -path '*/<message-id>/*.json'`

## Why This Is Feasible

- `continues` already distinguishes SQLite vs JSON in `src/parsers/opencode.ts`.
- The backend-specific lookup paths are deterministic once the variant is known.

## Current `continues` Comparison

- Current handoff output exposes recent messages but not the backend variant, even though that is the most important retrieval decision for OpenCode.
- Current tool summaries collapse session-level diff metadata into one edit summary; the pointer block should instead tell the receiver where the real messages/parts live.

## Sources

- First-party issue: https://github.com/anomalyco/opencode/issues/13654 (accessed 2026-04-15)
- First-party repo code: `anomalyco/opencode` files `packages/opencode/src/storage/db.ts` and `packages/opencode/src/storage/storage.ts` (read 2026-04-15)
- Local parser: `src/parsers/opencode.ts` (read 2026-04-15)

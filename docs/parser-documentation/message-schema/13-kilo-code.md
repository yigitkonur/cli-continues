# Kilo Code Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: First-party Kilo issue reports explicitly reference `ui_messages.json` and `ui_messages.json.lock` under `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/<task-id>/`.
- Documented fact: That same issue describes large `ui_messages.json` files and stale lock-file behavior in real Kilo task directories.
- Documented fact: The official `Kilo-Org/kilocode` repository also contains a newer persistence layer built around `kilo.db` plus OpenCode-style `session/message/part` storage and JSON-to-SQLite migration code.
- Unresolved uncertainty: This repo-level evidence suggests either a product split or an ongoing migration. The parser in `continues` currently targets the legacy extension-style `ui_messages.json` path only.

## Assistant Messages

- Inference: For the legacy extension path backed by `ui_messages.json`, Kilo appears to share the Cline/Roo message model and assistant-chunk semantics.
- Documented fact: First-party issue reporting about `ui_messages.json` confirms that this file is the active UI task history in at least some Kilo builds.
- Documented fact: In the newer `kilo.db` code path, assistant messages are fully structured session/message/part records with explicit assistant roles, tool parts, reasoning parts, and compaction parts.

## User Messages

- Inference: User-turn encoding depends on which Kilo storage generation is in use.
- Legacy extension path likely mirrors Roo/Cline-style `ui_messages.json`.
- Newer repo-level persistence mirrors OpenCode-style `message.data.role: "user"` plus structured parts.

## Ordering, Boundaries, And Migration Risk

- Documented fact: The issue-backed extension path uses task directories and lock files around `ui_messages.json`.
- Documented fact: The newer repo code uses `kilo.db` and OpenCode-style session/message/part ordering.
- Inference: Message-boundary and assistant-coverage logic for Kilo cannot safely assume one stable upstream schema today.

## Direct Access

- Legacy extension path: inspect `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/<task-id>/ui_messages.json`
- Newer repo-backed path, if present: inspect the Kilo database path described by the upstream code (`kilo.db`)

## Parser Comparison

- `src/parsers/cline.ts` likely matches legacy extension installs that still use `ui_messages.json`.
- The parser has no coverage for the newer `kilo.db`/OpenCode-style persistence exposed in the current official repository.
- This makes Kilo Code one of the highest schema-drift risks in the supported tool list: the current parser may be “right for the old product channel, wrong for the current core codebase.”

## Sources

- Kilo storage issue: https://github.com/Kilo-Org/kilocode/issues/3706 (accessed 2026-04-15)
- Kilo DB code: https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/storage/db.ts (accessed 2026-04-15)
- Kilo JSON migration code: https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/storage/json-migration.ts (accessed 2026-04-15)
- Kilo session/message schema: https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/session/index.ts (accessed 2026-04-15)
- Kilo message schema: https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/session/message-v2.ts (accessed 2026-04-15)

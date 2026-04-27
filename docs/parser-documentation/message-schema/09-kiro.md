# Kiro Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: Kiro CLI automatically saves chat sessions on every turn.
- Documented fact: Sessions are stored per directory, can be listed/resumed by UUID session ID, and can be exported/imported as JSON files via `/chat save` and `/chat load`.
- Documented fact: The Kiro docs describe the active session store as a database-backed concept but do not publish the on-disk internal schema.
- Unresolved uncertainty: I did not find a first-party public document that confirms the internal `workspace-sessions/*.json` layout currently assumed by `src/parsers/kiro.ts`.
- Observed example: No local Kiro session artifacts were present on this machine for direct inspection.

## Assistant Messages

- Inference: Kiro clearly persists assistant turns because it can resume, list, save, and reload chat sessions.
- Unresolved uncertainty: The exact raw assistant-message object shape is not publicly documented in the sources reviewed for this audit.
- Inference: The parser’s assumed `history[]` entries with `message.role` and `message.content` may reflect a real app build, but that assumption is not independently validated here.

## User Messages

- Documented fact: Kiro resumes and exports full conversations, so user turns are definitely persisted.
- Unresolved uncertainty: The exact raw user-message JSON shape is likewise undocumented in the public sources reviewed here.

## Ordering, Boundaries, And Compaction

- Documented fact: Kiro sessions are scoped per directory and have UUID session IDs.
- Documented fact: The most recently updated sessions appear first when listed.
- Unresolved uncertainty: No public source in this audit exposed a compaction marker, summary record, or raw turn-order file format.

## Direct Access

- Officially documented operations:
- `kiro-cli chat --list-sessions`
- `kiro-cli chat --resume`
- `kiro-cli chat --resume-id <SESSION_ID>`
- `/chat save <FILE_PATH>` to write a JSON export
- `/chat load <FILE_PATH>` to read a JSON export

## Parser Comparison

- `src/parsers/kiro.ts` assumes a concrete internal file layout: `~/Library/Application Support/Kiro/workspace-sessions/<workspace>/<session>.json` with fields like `sessionId`, `workspacePath`, `selectedModel`, and `history[]`.
- The public Kiro docs used here do not validate that internal shape. They validate session behavior, UUIDs, per-directory scope, and JSON export/import only.
- That means the current parser may be correct for a specific desktop build, but its assistant-message and ordering assumptions remain externally unverified.

## Sources

- Kiro chat docs: https://kiro.dev/docs/cli/chat/ (accessed 2026-04-15)
- Kiro CLI command reference: https://kiro.dev/docs/cli/reference/cli-commands/ (accessed 2026-04-15)

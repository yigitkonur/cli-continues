# Cursor

Accessed: 2026-04-15

## Observed Example

- Official Cursor community forum posts place chat transcripts under:
  - `~/.cursor/projects/<project-name>/agent-transcripts`
- A later official forum bug report shows a second recovery dependency:
  - transcript files may still exist under `.cursor/projects/.../agent-transcripts`
  - UI recovery can still depend on Cursor-side global storage such as `state.vscdb` and `workspaceStorage`

## Documented Fact

- Public Cursor Help docs document sharing/export flows, but I did not find first-party storage-path documentation there.
- No public env-var override for the local transcript root was found.

## Inference

- `agent-transcripts` is a real local transcript store.
- It is probably not the only store required for perfect UI/session recovery, because Cursor staff recommend restoring both transcript-adjacent IDE state and global DB/storage files during corruption events.
- The transcript payload is JSONL, matching both the local parser assumption and the observed filesystem references.
- The transcript files are likely append-oriented, but that write behavior is not first-party documented.

## Unresolved Uncertainty

- No first-party public doc was found for:
  - exact transcript schema
  - append/update semantics beyond “transcripts exist on disk”
  - whether the transcript filename or a separate DB row is the canonical session ID
  - any env-var override for the storage root

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/cursor.ts` assume `~/.cursor/projects/*/agent-transcripts/<uuid>/<uuid>.jsonl`.
- Confidence:
  - `agent-transcripts` itself is well corroborated.
  - the `<uuid>/<uuid>.jsonl` nesting and “filename equals session ID” behavior are still parser-side inferences.
- Gap: `continues` ignores Cursor’s IDE/global-state dependencies, so it can recover transcript text without necessarily matching Cursor’s full notion of recoverable history.

## Direct Access Recipe

- Transcript root:
  - `~/.cursor/projects/<project-name>/agent-transcripts/`
- Recovery-adjacent IDE state mentioned by staff:
  - `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
  - `%APPDATA%\Cursor\User\workspaceStorage`

## Sources

- Official forum: https://forum.cursor.com/t/where-are-cursor-chats-stored/77295/5
- Official forum: https://forum.cursor.com/t/lost-all-cursor-settings-and-chat-history-for-all-projects-i-am-working-on/151081

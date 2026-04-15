# Cline Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: Cline stores per-task UI history in `ui_messages.json` inside its globalStorage task directory.
- Documented fact: The official code reads and writes `ui_messages.json` through `getSavedClineMessages(...)` and `saveClineMessages(...)`.
- Documented fact: Other task files exist too, including `api_conversation_history.json`, but `ui_messages.json` is the persisted UI message stream.

## Assistant Messages

- Documented fact: Cline UI messages are not simple `role/content` objects; they are `ClineMessage` entries with `type`, `say`/`ask`, `text`, `partial`, and timestamps.
- Observed example from current local parser logic: assistant-visible entries come from `type: "say"` with:
- `say: "text"` and `partial: true` for streaming assistant text chunks
- `say: "completion_result"` for completed assistant output
- `say: "reasoning"` for assistant reasoning text
- Inference: Assistant turns may be spread across multiple adjacent partial chunks before a final non-partial completion.

## User Messages

- Observed example from current local parser logic: user turns come from:
- `say: "user_feedback"`
- some non-partial `say: "text"` entries that represent user input
- Inference: Role reconstruction is semantic, not explicit in the raw file.

## Ordering, Boundaries, And Partial Chunks

- Documented fact: `ui_messages.json` is an array, so array order is the primary chronological model.
- Documented fact: Every message has a `ts` timestamp.
- Documented fact: The official task code updates partial messages in place and saves the array back to disk.
- Inference: Recent-conversation extraction must deduplicate/merge consecutive assistant partial chunks to avoid replaying stale intermediate text.

## Direct Access

- Cline task dir: look under VS Code/Cursor globalStorage for `.../tasks/<task-id>/ui_messages.json`
- Inspect raw UI messages: `jq . <task-dir>/ui_messages.json`

## Parser Comparison

- `src/parsers/cline.ts` matches the official storage file (`ui_messages.json`) and correctly deduplicates consecutive assistant partial text chunks.
- The parser intentionally produces no tool summaries because official Cline tool-level detail lives outside `ui_messages.json`, notably in `api_conversation_history.json` and other task metadata.
- That means the parser’s conversation extraction is plausible, but its tool/activity view is knowingly incomplete if only `ui_messages.json` is consulted.

## Sources

- Cline disk storage code: https://github.com/cline/cline/blob/main/src/core/storage/disk.ts (accessed 2026-04-15)
- Observed local parser assumptions: `src/parsers/cline.ts` in this repo, read 2026-04-15

# Gemini CLI Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: The official `google-gemini/gemini-cli` code now records conversations as append-only JSONL files under `~/.gemini/tmp/<project-id>/chats/`.
- Documented fact: Current chat files begin with partial metadata records and then append message records, `$set` metadata updates, and `$rewindTo` rewind markers.
- Documented fact: The current message-record model includes `type: 'user' | 'gemini' | 'info' | 'error' | 'warning'`.
- Observed example: A local older-format session file was a single JSON object with `sessionId`, `projectHash`, `startTime`, `lastUpdated`, and `messages[]`.
- Observed example: Local `~/.gemini/projects.json` maps absolute project roots to short project IDs used in `~/.gemini/tmp/<project-id>/...`.

## Assistant Messages

- Documented fact: In the current official schema, assistant turns use `type: "gemini"`.
- Documented fact: `gemini` messages can carry `content`, `toolCalls`, `thoughts`, `tokens`, and `model`.
- Observed example: In the sampled legacy JSON file, `gemini` entries also contained `toolCalls`, `thoughts`, `tokens`, and `model`.

## User Messages

- Documented fact: User turns use `type: "user"` in both the current JSONL schema and the sampled legacy JSON schema.
- Documented fact: The loader’s first-user extraction reads text from `content` parts and treats those as the primary prompt text.

## Ordering, Boundaries, And Rewind

- Documented fact: Current storage is append-only JSONL, but effective history is not just file order.
- Documented fact: `$rewindTo` records truncate later logical messages, and repeated records with the same message `id` are aggregated on load.
- Documented fact: Metadata updates are appended as `$set` records rather than rewriting the file.
- Inference: Any recent-message extraction that does not replay `$rewindTo` and merge duplicate message IDs can produce the wrong conversation tail.

## Direct Access

- Current-format files: `find ~/.gemini/tmp -path '*/chats/*.jsonl'`
- Legacy-format files: `find ~/.gemini/tmp -path '*/chats/*.json'`
- Project-ID mapping: `cat ~/.gemini/projects.json`

## Parser Comparison

- `src/parsers/gemini.ts` is now behind upstream storage: it only scans `session-*.json` files and ignores the current JSONL format documented in the official repo.
- The parser also leaves `cwd` empty even though `projects.json` plus `projectHash` can recover more project context than an empty string.
- The parser’s message-shape assumptions still match older local JSON examples, so it is not universally wrong; it is version-skewed.
- This is a high-risk assistant-message coverage bug because current installs can store `gemini` assistant turns in files the parser never opens.

## Sources

- Gemini storage/config code: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/storage.ts (accessed 2026-04-15)
- Gemini chat recording service: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts (accessed 2026-04-15)
- Gemini chat recording types: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts (accessed 2026-04-15)
- Observed local legacy session: `~/.gemini/tmp/73a653feba8da3ab78a2b1507f0e46a718a8c5820242bd4b84df046d4ae52e8c/chats/session-2026-02-18T20-41-3d0ca2eb.json` (accessed 2026-04-15)
- Observed local project map: `~/.gemini/projects.json` (accessed 2026-04-15)

# Cursor Agent Message Schema

Access date: 2026-04-15

## Raw Schema

- Observed example: Sampled Cursor agent transcripts lived under `~/.cursor/projects/<project-slug>/agent-transcripts/<session-id>.jsonl`.
- Observed example: Sampled transcript lines were simple JSON objects with top-level `role` and `message`, where `message.content` was an array of blocks.
- Observed example: In sampled files, `message.content` only contained `text` blocks.
- Unresolved uncertainty: No first-party Cursor schema document was located that fully specifies the raw `agent-transcripts` format.

## Assistant Messages

- Observed example: Assistant turns use `role: "assistant"`.
- Observed example: Sampled assistant lines exposed only text blocks; no explicit `tool_use`, `tool_result`, `usage`, or `model` fields were present in the sampled transcript.
- Inference: Cursor may emit richer Anthropic-style payloads in some builds, but that is not guaranteed by the sampled local files.

## User Messages

- Observed example: User turns use `role: "user"` and text blocks under `message.content[]`.
- Inference: Human/user boundaries are easy to recover from sampled transcripts because the records are already role-tagged and text-only.

## Ordering, Boundaries, And Compaction

- Observed example: JSONL line order is the only clear ordering signal in sampled transcripts; the sampled lines lacked explicit top-level timestamps.
- Unresolved uncertainty: Public community feedback indicates Cursor’s exported JSONL may not always fully preserve tool-use information, which means transcript completeness is tool/version-dependent.
- Unresolved uncertainty: No explicit compaction marker or summary record was observed in local transcripts.

## Direct Access

- Transcript path: `find ~/.cursor/projects -path '*/agent-transcripts/*.jsonl'`
- Inspect a transcript: `jq -c . ~/.cursor/projects/<slug>/agent-transcripts/<session>.jsonl`

## Parser Comparison

- `src/parsers/cursor.ts` assumes the transcript may contain Anthropic-compatible tool blocks plus assistant `usage`/`model` passthrough fields, and it runs `extractAnthropicToolData(...)` over every line.
- The sampled local transcripts did not expose those richer blocks, so current tool-activity and assistant-token coverage is uncertain and may be overstated for some Cursor sessions.
- This directly affects assistant-message inclusion and recent-message trimming because the parser may infer structure that the raw transcript did not actually preserve.

## Sources

- Cursor community thread: https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311 (accessed 2026-04-15)
- Cursor community thread: https://forum.cursor.com/t/jsonl-format-should-fully-record-the-tool-use-information/154777 (accessed 2026-04-15)
- Observed local transcript: `~/.cursor/projects/Users-yigitkonur-dev-test-cli-continues/agent-transcripts/16f31a93-4d65-4b9d-bad9-bb082f4aa56e.jsonl` (accessed 2026-04-15)

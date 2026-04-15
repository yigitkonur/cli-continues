# Antigravity Message Schema

Access date: 2026-04-15

## Raw Schema

- Observed example: The local Antigravity install stores conversation-like artifacts under `~/.gemini/antigravity/conversations/*.pb`.
- Observed example: Sampled `.pb` files are binary, not JSON or JSONL; `file` reported generic binary data and a hex dump showed no JSON framing.
- Observed example: `~/.gemini/antigravity/code_tracker/` primarily contained active-file snapshots and related artifacts, not line-delimited conversation logs.
- Observed example: Additional directories existed under `.gemini/antigravity/`, including `brain/`, `daemon/`, `browser_recordings/`, and `code_tracker/`.
- Unresolved uncertainty: I did not locate a first-party public schema for the protobuf conversation files during this audit.

## Assistant Messages

- Unresolved uncertainty: The exact assistant-message representation inside `conversations/*.pb` is not publicly documented in the evidence reviewed here.
- Inference: Assistant turns almost certainly exist in the protobuf conversation files, but the current parser does not read that format.

## User Messages

- Unresolved uncertainty: Same as assistant messages; the current protobuf wire shape is not publicly documented in the sources reviewed here.

## Ordering, Boundaries, And Related Artifacts

- Observed example: The existence of per-conversation `.pb` files suggests one conversation artifact per session or thread.
- Observed example: `code_tracker/active/...` looks like file-tracking/storage support, not the canonical message transcript.
- Inference: The current parser’s assumption of `{type, content, timestamp}` JSON lines under `code_tracker/` is likely based on an older or different Antigravity storage surface than the one currently installed.

## Direct Access

- Conversation artifacts: `find ~/.gemini/antigravity/conversations -name '*.pb'`
- Supporting artifacts: `find ~/.gemini/antigravity -maxdepth 2 -type d`

## Parser Comparison

- `src/parsers/antigravity.ts` currently assumes `.json`/`.jsonl` conversation logs under `.gemini/antigravity/code_tracker/` and parses lines into `{type, timestamp, content}`.
- The local install contradicts that assumption: the only clearly conversation-scoped artifacts I found were binary `.pb` files under `.gemini/antigravity/conversations/`.
- This is a high-confidence, high-severity mismatch. On current local evidence, the parser is likely outdated and may not parse real Antigravity sessions at all.

## Sources

- Observed local conversation file: `~/.gemini/antigravity/conversations/b88b0608-c1e9-4029-a7ac-f932303fef5f.pb` (accessed 2026-04-15)
- Observed local directories: `~/.gemini/antigravity/` (accessed 2026-04-15)

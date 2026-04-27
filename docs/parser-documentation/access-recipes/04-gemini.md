# Gemini Access Recipes

## Raw Source

- Documented fact: first-party session-management docs place saved sessions under `~/.gemini/tmp/<project_hash>/chats/` and say sessions include prompts, model responses, tool executions, token usage, and reasoning summaries. Source: [Gemini CLI session management](https://geminicli.com/docs/cli/session-management/) (accessed 2026-04-15).
- Documented fact: Google’s blog says the feature is automatic from v0.20.0+, project-scoped, and restorable via `/resume`, `--resume`, and `--list-sessions`. Source: [Google blog post](https://developers.googleblog.com/pick-up-exactly-where-you-left-off-with-session-management-in-gemini-cli/) (accessed 2026-04-15).
- Documented fact: current upstream repo code writes append-only JSONL chat records with metadata updates, message records, thoughts, tokens, tool calls, rewind markers, and subagent chat directories. Source: [google-gemini/gemini-cli `chatRecordingService.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts) (accessed 2026-04-15).
- Observed example: this machine still stores `session-*.json` blobs in `~/.gemini/tmp/<project>/chats/`, and those JSON files contain a top-level `messages` array with `type`, `content`, `thoughts`, `tokens`, and `model`. Observed 2026-04-15.
- Inference: Gemini CLI appears to be in a storage transition from JSON session blobs to JSONL chat records; future pointer blocks should include both the path and the detected format version.

## Retrieval Patterns

### If the session is a JSON blob

```bash
file=~/.gemini/tmp/<project>/chats/session-2026-04-06T08-43-867ca735.json
jq '.messages[9:30]' "$file"
```

### Tool calls from a JSON blob

```bash
jq -cr '
  .messages[9:30][]
  | select(.type=="gemini" and (.toolCalls // [] | length > 0))
  | .toolCalls[]
' "$file"
```

### If the install has switched to JSONL

```bash
awk 'NR>=10 && NR<=30' "$JSONL_CHAT" | jq .
```

### Resume/list commands that are worth surfacing in a pointer block

```bash
gemini --list-sessions
gemini --resume
gemini --resume <SESSION_ID>
```

## Current Parser Comparison

- Current parser matches the observed local JSON format, not the current upstream JSONL writer on `main`.
- The redesign should expose the actual file format it detected so downstream agents know whether to use `jq '.messages[...]'` or line-oriented JSONL slicing.
- Current handoff also omits the possibility of richer JSONL-only artifacts like rewind records and subagent chat directories.

## Sources

- [Gemini CLI session management](https://geminicli.com/docs/cli/session-management/) (accessed 2026-04-15)
- [Google blog: Gemini CLI session management](https://developers.googleblog.com/pick-up-exactly-where-you-left-off-with-session-management-in-gemini-cli/) (accessed 2026-04-15)
- [google-gemini/gemini-cli `chatRecordingService.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts) (accessed 2026-04-15)

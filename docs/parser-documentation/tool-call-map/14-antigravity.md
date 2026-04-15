# Antigravity

## Raw storage

- Documented fact:
  - A first-party public product announcement for Google Antigravity exists, but no first-party session-schema or code-tracker-storage reference was found.
- Observed example:
  - Local Antigravity files exist under `~/.gemini/antigravity/code_tracker/`.
  - Sampled files in `code_tracker/active/...` looked like prefixed file snapshots such as `*_CLAUDE.md`, `*.tsx`, and `*.py`, not obvious conversation transcripts.
  - Local Antigravity data also includes `browser_recordings/.../*.jpg`.
- Inference:
  - The local `code_tracker` on this machine appears to be a file-tracking corpus, not an obviously parseable assistant/user conversation log.
- Unresolved uncertainty:
  - No public first-party schema was found for Antigravity session history, transcript logs, or exact tool-call persistence.

## Tool-call encoding

- Observed example:
  - No local evidence of structured `tool_use`, `tool_result`, `toolCalls`, or conversation-role JSON was found inside the sampled `code_tracker` files.
- Inference:
  - `src/parsers/antigravity.ts` should be treated as provisional until a canonical upstream log format is confirmed.
- Unresolved uncertainty:
  - Whether Antigravity stores raw chat history outside `code_tracker`, or inside other machine-local directories, remains open.

## Write, edit, delete, search, MCP, shell

- Unresolved uncertainty:
  - No evidence-backed first-party schema was found for Antigravity write/edit/delete/search/shell tool logging.

## What `continues` abstracts away today

- `src/parsers/antigravity.ts` assumes JSON/JSONL conversation entries with `{type, content, timestamp}` inside `code_tracker`.
- Local evidence here points the other way: sampled files look like tracked file snapshots with binary-ish prefixes.
- This is the single weakest parser/storage match in the current product.

## Direct-access recipe

```bash
find ~/.gemini/antigravity/code_tracker -type f | head -n 20

find ~/.gemini/antigravity/code_tracker -type f | head -n 3 | while read f; do
  echo "$f"
  xxd -l 64 "$f"
done
```

## Sources

- Accessed 2026-04-15: https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/
- Observed locally on 2026-04-15: `~/.gemini/antigravity/code_tracker/...`

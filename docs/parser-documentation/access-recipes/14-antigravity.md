# Antigravity Access Recipes

## Raw Source

- Documented fact: current first-party Antigravity docs pages reviewed for this audit do not describe local session storage, `code_tracker`, browser recordings, or raw transcript files. Sources: [docs root](https://antigravity.google/docs), [docs home](https://antigravity.google/docs/home), [browser docs](https://antigravity.google/docs/browser) (accessed 2026-04-15).
- Current parser assumption: `~/.gemini/antigravity/code_tracker/` contains JSON or JSONL conversation logs with `{type, content, timestamp}` style entries.
- Observed example: this machine does have `~/.gemini/antigravity/code_tracker/`, but `code_tracker/active/` looks like tracked workspace file snapshots, not chat transcripts, and a search for `*.json` / `*.jsonl` under `code_tracker/` returned only a normal project JSON file, not a session log. Observed 2026-04-15.
- Observed example: this machine also has `~/.gemini/antigravity/browser_recordings/<id>/*.jpg`, which may matter for browser-task replay but is not currently surfaced by the parser.
- Unresolved: the current parser appears likely wrong or at least incomplete for present-day Antigravity storage.

## Retrieval Patterns

### Inspect directory composition before assuming transcript files exist

```bash
find ~/.gemini/antigravity -maxdepth 3 | head -n 80
find ~/.gemini/antigravity/code_tracker -type f | head -n 40
```

### Check whether any chat-like JSON/JSONL logs exist

```bash
find ~/.gemini/antigravity/code_tracker -type f \( -name '*.json' -o -name '*.jsonl' \)
```

### Inspect browser recordings if the task involved the Antigravity browser

```bash
find ~/.gemini/antigravity/browser_recordings -maxdepth 2 -type f | head -n 40
```

## Current Parser Comparison

- This is the highest-risk mismatch in the audit.
- The parser expects chat-like JSON entries in `code_tracker/`, but local observation suggests `code_tracker/active/` is a file-tracking area rather than a conversation log.
- A redesign pointer block should not pretend this raw source is verified. It should surface the path as tentative and fall back to directory inspection instructions.

## Sources

- [Antigravity docs root](https://antigravity.google/docs) (accessed 2026-04-15)
- [Antigravity docs home](https://antigravity.google/docs/home) (accessed 2026-04-15)
- [Antigravity browser docs](https://antigravity.google/docs/browser) (accessed 2026-04-15)


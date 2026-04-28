# Antigravity Access Recipes

## Raw Sources

- Primary root: `~/.gemini/antigravity/`
- Session discovery: `conversations/*.pb`, `brain/<id>/`, and `state.vscdb` trajectory summaries.
- Context extraction:
  - Offline: `brain/<id>/task.md`, `implementation_plan.md`, `walkthrough.md`, and `.resolved*` variants.
  - Live: local Antigravity language-server RPC when the app is running.
- Legacy fallback: chat-shaped JSON/JSONL under `code_tracker/`; snapshot-only files are ignored.

## Retrieval Patterns

### Inspect current session IDs

```bash
find ~/.gemini/antigravity/conversations -maxdepth 1 -name '*.pb' -print
find ~/.gemini/antigravity/brain -maxdepth 1 -type d -print
```

### Inspect offline handoff artifacts

```bash
find ~/.gemini/antigravity/brain/<conversation-id> -maxdepth 1 -type f \
  \( -name 'task.md*' -o -name 'implementation_plan.md*' -o -name 'walkthrough.md*' \)
```

### Inspect state-summary availability

```bash
sqlite3 "$HOME/Library/Application Support/Antigravity/User/globalStorage/state.vscdb" \
  "SELECT key, length(value) FROM ItemTable WHERE key LIKE '%trajectorySummaries%'"
```

### Confirm `code_tracker` is not being mistaken for chat

```bash
find ~/.gemini/antigravity/code_tracker -type f \( -name '*.json' -o -name '*.jsonl' \)
```

## Current Parser Comparison

- The parser now indexes current Antigravity installs even when `code_tracker` contains only file snapshots.
- Offline handoffs are artifact-backed and explicitly note that full raw transcript extraction requires live Antigravity.
- Legacy JSONL remains supported only for files with real user/assistant chat entries.

## Sources

- [Antigravity docs root](https://antigravity.google/docs)
- [Antigravity artifacts docs](https://antigravity.google/docs/artifacts)
- Third-party sync evidence: https://github.com/mrd9999/antigravity-sync

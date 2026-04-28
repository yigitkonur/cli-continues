# Antigravity

Accessed: 2026-04-28

## Observed Storage

- Root: `~/.gemini/antigravity/`
- Persisted conversation IDs: `conversations/*.pb`
- Handoff artifacts: `brain/<conversation-id>/task.md`, `implementation_plan.md`, `walkthrough.md`, plus `.resolved*` variants.
- UI/index metadata: Antigravity global storage SQLite at `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` on macOS.
- Auxiliary local data: `code_tracker/`, `browser_recordings/`, `implicit/`, `knowledge/`, and account/setting files.

## Parser Behavior

- `src/parsers/antigravity.ts` now discovers sessions from the union of `conversations/*.pb`, `brain/<id>/`, `state.vscdb` trajectory summaries, and optional live language-server RPC.
- `code_tracker/` is no longer treated as canonical. It is parsed only as a legacy fallback when a file actually contains chat-shaped `{type, content, timestamp}` records.
- Offline extraction does not decrypt `.pb`; it builds a useful handoff from brain artifacts and state metadata.
- When Antigravity is running, the parser attempts read-only RPC extraction for full steps, messages, tool activity, and modified files.

## Remaining Uncertainty

- First-party docs still do not publish the raw `conversations/*.pb` schema.
- Offline full transcript reconstruction from `.pb` remains intentionally unsupported by default because it would require private schema/decryption behavior.
- Live RPC method and field names are private implementation details, so extraction is best-effort and falls back to offline artifacts.

## Direct Access Recipe

```bash
find ~/.gemini/antigravity/conversations -name '*.pb'
find ~/.gemini/antigravity/brain -maxdepth 2 -type f | head -n 80
sqlite3 "$HOME/Library/Application Support/Antigravity/User/globalStorage/state.vscdb" \
  "SELECT key, length(value) FROM ItemTable WHERE key LIKE '%trajectorySummaries%'"
```

## Sources

- Third-party sync evidence: https://github.com/mrd9999/antigravity-sync
- Google Antigravity docs root: https://antigravity.google/docs

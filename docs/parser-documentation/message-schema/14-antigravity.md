# Antigravity Message Schema

Access date: 2026-04-28

## Raw Schema

- Persisted conversation files live at `~/.gemini/antigravity/conversations/*.pb`.
- The public protobuf schema for those files is not documented in the sources reviewed.
- Session metadata is recoverable from Antigravity global `state.vscdb` trajectory summaries.
- Human-readable task context is recoverable from `brain/<id>/` markdown artifacts and `.resolved*` variants.
- Full message/tool steps are available only when the local Antigravity language server is running.

## Parser Mapping

- Discovery merges `.pb` files, brain artifact folders, state summaries, and live RPC summaries by conversation ID.
- Live user steps map to normalized `user` messages.
- Live planner responses map to normalized `assistant` messages; planner thinking is recorded as session reasoning highlights.
- Live command/file/tool steps map to `SummaryCollector` tool summaries and modified-file tracking where paths are available.
- Offline fallback produces synthetic recent messages from `task.md`, `implementation_plan.md`, and `walkthrough.md` so the handoff remains useful without decrypting `.pb`.

## Legacy Compatibility

- `code_tracker` JSON/JSONL is accepted only when it contains chat-shaped `{type, content, timestamp}` entries.
- Arbitrary JSON snapshots in `code_tracker/active` are ignored and do not create sessions.

## Direct Access

```bash
find ~/.gemini/antigravity/conversations -name '*.pb'
find ~/.gemini/antigravity/brain/<conversation-id> -maxdepth 1 -type f
```

## Remaining Uncertainty

- Offline raw transcript reconstruction from `.pb` remains unresolved without a stable first-party schema.
- Live RPC is private and best-effort; when unavailable, artifact-based handoff is the supported fallback.

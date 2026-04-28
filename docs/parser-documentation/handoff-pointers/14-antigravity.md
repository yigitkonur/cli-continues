# Antigravity

## Documented Facts

- Antigravity stores local data under `~/.gemini/antigravity/`.
- Current local/session evidence points to `conversations/*.pb` for persisted session IDs and `brain/<id>/` for user-visible task artifacts.
- `code_tracker/` is auxiliary and may contain file snapshots rather than conversation logs.

## Current Pointer Strategy

- `Session`: Antigravity / `<conversation-id>`
- `Storage variant`: `pb + brain artifacts`, `live RPC enriched`, or `legacy code_tracker JSONL`
- `Confidence`: high for discovery, medium for live transcript/tool extraction, low for offline raw transcript reconstruction from `.pb`
- `Raw path`: prefer `conversations/<id>.pb`; use `brain/<id>/` or legacy JSONL path when that is the only source.
- `Offline artifacts`: list `task.md*`, `implementation_plan.md*`, and `walkthrough.md*` when present.
- `Live note`: if live RPC was unavailable, state that the handoff is artifact-based rather than raw transcript-based.

## Default-Mode Pointer Block

- `Session`: Antigravity / `<session-id>`
- `Storage`: `~/.gemini/antigravity/`
- `Primary file`: `conversations/<session-id>.pb`
- `Artifacts`: `brain/<session-id>/`
- `Extraction`: live RPC transcript if available; otherwise brain artifact fallback.

## Full-Mode Pointer Block

- Everything from default mode.
- `State summary`: mention whether `state.vscdb` provided title, workspace path, timestamps, or step count.
- `Tool activity`: include command/file/tool summaries only when recovered from live RPC steps.
- `Legacy fallback`: only mention `code_tracker` when the parsed source is an actual chat-shaped JSON/JSONL file.

## Current `continues` Comparison

- `continues` no longer treats `code_tracker` as canonical Antigravity storage.
- The handoff should foreground whether it came from live RPC or offline artifacts so the receiving agent knows how complete the transcript is.

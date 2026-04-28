# Antigravity

## Raw Storage

- Persisted sessions are discovered from `~/.gemini/antigravity/conversations/*.pb`, `brain/<id>/`, and state trajectory summaries.
- `code_tracker/` is auxiliary; snapshot files there are not treated as tool-call logs or transcripts.
- Tool-call details are best recovered from the running Antigravity language server via local read-only RPC.

## Tool-Call Encoding

- Live `CORTEX_STEP_TYPE_RUN_COMMAND` steps map to shell summaries.
- Live `CORTEX_STEP_TYPE_VIEW_FILE` steps map to read-file summaries.
- Live `CORTEX_STEP_TYPE_TOOL_EXECUTION` and planner tool-call payloads map to generic MCP/tool summaries unless a high-confidence file write/edit path is present.
- Planner thinking is captured as session reasoning, not as a user-visible assistant message prefix.

## Offline Behavior

- Offline `.pb` files are not decrypted or parsed for tool calls.
- Offline handoffs use `brain/<id>/task.md*`, `implementation_plan.md*`, and `walkthrough.md*`; tool activity is empty unless live RPC was available.
- Pending tasks are extracted from unchecked markdown task items in brain artifacts.

## Legacy Behavior

- Legacy `code_tracker` JSON/JSONL contributes messages only when records contain `type: "user" | "assistant"` plus string `content`.
- Snapshot-only JSON in `code_tracker` is ignored.

## Direct-Access Recipe

```bash
find ~/.gemini/antigravity/conversations -name '*.pb'
find ~/.gemini/antigravity/brain/<conversation-id> -maxdepth 1 -type f
ps -axo pid=,command= | rg 'language_server_.*--app_data_dir antigravity'
```

## Sources

- Google Antigravity announcement: https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/
- Antigravity docs: https://antigravity.google/docs

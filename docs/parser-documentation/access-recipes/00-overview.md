# Access Recipes Overview

This folder answers one product question: what should a future handoff put at the top so a downstream agent can inspect deeper raw data without guessing.

## Most Actionable Pointer Fields

- Raw source path.
- Storage family: `jsonl`, `json`, `yaml+jsonl`, `sqlite`, or mixed.
- Session ID and any alternate IDs used by indexes or sidecars.
- One message-range recipe.
- One tool-call recipe.
- One "deeper artifacts" recipe for sidecars like subagents, snapshots, checkpoints, or DB tables.

## Highest-Value Retrieval Patterns

### JSONL append logs

These are the easiest to pointerize because the raw source is directly sliceable with line numbers.

- Claude, Codex, Droid, Cursor, Kimi, and Qwen all have JSONL-backed primary logs in at least one known format.
- For "messages 10-30", the baseline pattern is:

```bash
awk 'NR>=10 && NR<=30' "$SESSION_FILE" | jq .
```

- For "tool calls between messages 10 and 30", the main trick is filtering the tool-carrying records after line slicing:

```bash
awk 'NR>=10 && NR<=30' "$SESSION_FILE" \
  | jq -cr 'select(.type=="response_item" and .payload.type=="function_call")'
```

### JSON session blobs

These are best pointerized with array indexes, not line numbers.

- Gemini current local installs still show `session-*.json` blobs under `~/.gemini/tmp/*/chats/`.
- Amp threads are single JSON files under `~/.local/share/amp/threads/`.
- Kiro exposes explicit JSON save/load flows even though current parser assumptions target a different on-disk layout.

```bash
jq '.messages[9:30]' "$SESSION_JSON"
```

### SQLite

SQLite-backed tools need both table discovery and one or two canned joins.

- OpenCode: `opencode.db` is the richest single raw source in the entire tool set.
- Crush: `crush.db` is small and readable, with core data in `sessions` and `messages`.
- Codex also keeps a state DB alongside rollout JSONL; the parser currently ignores it.
- Copilot ships a `session.db`, but observed local installs use it for todos, not conversation replay.

```bash
sqlite3 "$DB" '.tables'
sqlite3 "$DB" 'PRAGMA table_info(session);'
```

## Highest-Risk Parser Mismatches

- Gemini: current parser expects JSON session blobs; current upstream Gemini CLI code writes JSONL records in `chatRecordingService.ts`. This looks like a format transition that the redesign should surface explicitly.
- Codex: current parser reads rollout JSONL only; local installs also expose `session_index.jsonl`, `history.jsonl`, `archived_sessions/`, and a state SQLite DB with `threads` and `thread_spawn_edges`.
- Copilot: current parser reads `workspace.yaml` and `events.jsonl`, but local sessions also contain `rewind-snapshots/`, `files/`, `checkpoints/`, `vscode.metadata.json`, and `session.db`.
- Kiro: current parser targets `~/Library/Application Support/Kiro/workspace-sessions/*.json`, but current first-party Kiro CLI docs describe `~/.kiro/` SQLite-backed auto-save plus JSON export/import commands.
- Antigravity: current parser assumes `~/.gemini/antigravity/code_tracker/` contains JSON/JSONL conversation logs; local observation on this machine shows `code_tracker/active/` behaving like tracked file snapshots, not chat transcripts.
- Claude: local observation confirmed `.jsonl` transcripts plus sibling `subagents/` and `tool-results/`, but did not find `sessions-index.json` even though multiple first-party issues discuss it.

## Recommended Pointer Block Shape

For the redesign, the pointer block should be compact and executable:

```text
Raw source: ~/.codex/sessions/2026/04/15/rollout-...jsonl
Format: JSONL
Session ID: 019d...
Inspect messages 10-30: awk 'NR>=10 && NR<=30' "$file" | jq .
Inspect tool calls: jq -cr 'select(.type=="response_item" and .payload.type=="function_call")' "$file"
Deeper artifacts: ~/.codex/state_5.sqlite -> tables: threads, thread_spawn_edges
```

## Sources

- [Claude Code settings](https://code.claude.com/docs/en/settings) (accessed 2026-04-15)
- [OpenAI Codex CLI features](https://developers.openai.com/codex/cli/features) (accessed 2026-04-15)
- [Gemini CLI session management](https://geminicli.com/docs/cli/session-management/) (accessed 2026-04-15)
- [Google blog: Gemini CLI session management](https://developers.googleblog.com/pick-up-exactly-where-you-left-off-with-session-management-in-gemini-cli/) (accessed 2026-04-15)
- [google-gemini/gemini-cli: chatRecordingService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts) (accessed 2026-04-15)
- [openai/codex: codex-rs/rollout/src/recorder.rs](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs) (accessed 2026-04-15)
- [anomalyco/opencode: session.sql.ts](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.sql.ts) (accessed 2026-04-15)
- [docs.cline.bot: Task History Recovery Guide](https://docs.cline.bot/troubleshooting/task-history-recovery) (accessed 2026-04-15)


# Codex Access Recipes

## Raw Source

- Documented fact: OpenAI docs say Codex stores transcripts locally and tells users to copy session IDs from files under `~/.codex/sessions/`. Source: [Codex CLI features](https://developers.openai.com/codex/cli/features) (accessed 2026-04-15).
- Documented fact: upstream code writes rollout JSONL files and explicitly shows inspection with `jq` and `fx`. Source: [openai/codex `recorder.rs`](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs) (accessed 2026-04-15).
- Documented fact: upstream code creates dated subdirectories under `sessions/YYYY/MM/DD/` for rollout files and also maintains a state DB path per Codex home. Source: same repo file plus local state DB observation on 2026-04-15.
- Observed example: this machine also has `~/.codex/session_index.jsonl`, `~/.codex/history.jsonl`, `~/.codex/archived_sessions/`, and `~/.codex/state_5.sqlite`. Observed 2026-04-15.

## Retrieval Patterns

### Locate the rollout file for a thread ID

```bash
id=019d9048-4378-73b2-a207-94b82b3ab6b7
find ~/.codex/sessions ~/.codex/archived_sessions -name "rollout-*-$id.jsonl"
```

### Slice messages 10-30

```bash
awk 'NR>=10 && NR<=30' "$ROLLOUT" | jq .
```

### Extract function calls and join outputs

```bash
jq -cr '
  select(.type=="response_item" and (.payload.type=="function_call" or .payload.type=="function_call_output"))
  | .payload
' "$ROLLOUT"
```

### Query thread metadata and spawn relationships from SQLite

```bash
sqlite3 ~/.codex/state_5.sqlite '.tables'
sqlite3 ~/.codex/state_5.sqlite \
  'SELECT id, title, rollout_path, cwd, git_branch, model, reasoning_effort FROM threads ORDER BY updated_at DESC LIMIT 20;'
sqlite3 ~/.codex/state_5.sqlite \
  'SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges LIMIT 20;'
```

### Inspect the lightweight indexes

```bash
sed -n '1,20p' ~/.codex/session_index.jsonl | jq .
sed -n '1,20p' ~/.codex/history.jsonl | jq .
```

## Current Parser Comparison

- Current parser reads rollout JSONL only. That is enough for conversation replay but not enough for a strong pointer block.
- The redesign should expose `rollout_path` plus the existence of the state SQLite DB and index JSONL files.
- Current parser also ignores `archived_sessions/`, which matters for resumed or archived work.

## Sources

- [Codex CLI features](https://developers.openai.com/codex/cli/features) (accessed 2026-04-15)
- [openai/codex `recorder.rs`](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs) (accessed 2026-04-15)
- [openai/codex discussion #3827](https://github.com/openai/codex/discussions/3827) (accessed 2026-04-15)


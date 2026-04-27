# Copilot Access Recipes

## Raw Source

- Documented fact, user-reported in first-party tracker: local session-state uses `workspace.yaml` and `events.jsonl` under `~/.copilot/session-state/`. Source: [github/copilot-cli issue #2396](https://github.com/github/copilot-cli/issues/2396) (accessed 2026-04-15).
- Documented fact, user-reported in first-party tracker: long-lived sessions may also involve `session.db`, and `events.jsonl` can contain multiple `session.start`, `session.resume`, and `session.shutdown` segments. Source: [issue #2209](https://github.com/github/copilot-cli/issues/2209) (accessed 2026-04-15).
- Observed example: local session directories on this machine contain `workspace.yaml`, `events.jsonl`, `checkpoints/`, `files/`, `rewind-snapshots/`, optional `vscode.metadata.json`, and sometimes `session.db`. Observed 2026-04-15.
- Observed example: the sampled `session.db` on this machine contains only `todos` and `todo_deps`, not the main conversation transcript. Observed 2026-04-15.

## Retrieval Patterns

### Read workspace metadata

```bash
dir=~/.copilot/session-state/<session-id>
sed -n '1,40p' "$dir/workspace.yaml"
```

### Slice event rows 10-30

```bash
awk 'NR>=10 && NR<=30' "$dir/events.jsonl" | jq .
```

### Extract assistant tool requests in that slice

```bash
awk 'NR>=10 && NR<=30' "$dir/events.jsonl" \
  | jq -cr '
      select(.type=="assistant.message")
      | {timestamp, content:.data.content, toolRequests:(.data.toolRequests // [])}
    '
```

### Inspect rewind snapshot metadata

```bash
sed -n '1,120p' "$dir/rewind-snapshots/index.json" | jq .
```

### Discover whether `session.db` is worth querying

```bash
sqlite3 "$dir/session.db" '.tables'
sqlite3 "$dir/session.db" 'SELECT * FROM todos LIMIT 20;'
```

## Current Parser Comparison

- Current parser reads `workspace.yaml` and `events.jsonl`, which is correct for core conversation recovery.
- The current handoff misses deeper artifacts that are useful for technical follow-up: `rewind-snapshots/index.json`, checkpoint markdown, sidecar files, and the presence or absence of a meaningful `session.db`.
- The redesign should not assume `session.db` contains transcript rows; local observation suggests it may only hold task/todo state.

## Sources

- [github/copilot-cli issue #2396](https://github.com/github/copilot-cli/issues/2396) (accessed 2026-04-15)
- [github/copilot-cli issue #2209](https://github.com/github/copilot-cli/issues/2209) (accessed 2026-04-15)


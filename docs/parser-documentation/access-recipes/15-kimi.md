# Kimi Access Recipes

## Raw Source

- Documented fact: Kimi Code CLI v2 (>= 0.39) creates session directories under
  `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/`, writes v2
  `state.json`, and records the conversation in `agents/main/wire.jsonl`
  (protocol 1.5). Sources: observed locally 2026-08-28; official repo
  [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli).
- Documented fact: `session_index.jsonl` is the authoritative index of
  `{sessionId, sessionDir, workDir}`; `workspaces.json` maps `wd_<name>_<hash>`
  dirs to workspace roots.
- Documented fact: legacy pre-0.39 sessions live under
  `~/.kimi/sessions/<md5>/<session-id>/` with `context.jsonl`, `metadata.json`,
  v1 `state.json`, and `wire.jsonl` (read by the parser as a fallback).
- Observed example: this machine has `~/.kimi-code/session_index.jsonl`,
  `~/.kimi-code/workspaces.json`, and
  `~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`. Observed
  2026-08-28.

## Retrieval Patterns

### Map workspaces to session roots

```bash
jq . ~/.kimi-code/workspaces.json
sed -n '1,40p' ~/.kimi-code/session_index.jsonl
find ~/.kimi-code/sessions -maxdepth 3 -type d
```

### Inspect wire metadata and first records

```bash
sed -n '1,10p' ~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl | jq .
```

### Inspect the session state

```bash
jq . ~/.kimi-code/sessions/wd_*/session_*/state.json
```

### Enumerate wire record types

```bash
grep -o '"type": "[^"]*"' ~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl | sort | uniq -c
```

## Current Parser Comparison

- Current parser reads `session_index.jsonl`, `workspaces.json`, v2
  `state.json`, and `agents/main/wire.jsonl`, which aligns with the current CLI.
- The parser ignores `tools.update_store` (todo store) and subagent
  `agents/agent-N/wire.jsonl` conversations.
- For Kimi, the pointer block should include both `state.json` and
  `agents/main/wire.jsonl`.

## Sources

- Observed locally on 2026-08-28: kimi 0.39.1 `~/.kimi-code/` layout
- [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)

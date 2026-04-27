# Kimi Access Recipes

## Raw Source

- Documented fact: upstream Kimi CLI creates session directories under a work-dir-scoped sessions root, writes `context.jsonl`, and also writes a `wire.jsonl` file with a metadata header plus typed wire records. Sources: [MoonshotAI/kimi-cli `session.py`](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py), [MoonshotAI/kimi-cli `wire/file.py`](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py) (accessed 2026-04-15).
- Documented fact: `metadata.json` is optional in Kimi, and session lookup also uses `kimi.json` work-dir metadata. Source: `session.py`, accessed 2026-04-15.
- Observed example: this machine has `~/.kimi/kimi.json`, `~/.kimi/sessions/<workdir-hash>/<session-id>/context.jsonl`, and `wire.jsonl`. Observed 2026-04-15.
- Observed example: `wire.jsonl` begins with a metadata line like `{\"type\":\"metadata\",\"protocol_version\":\"1.3\"}`, followed by `TurnBegin` wire records. Observed 2026-04-15.

## Retrieval Patterns

### Map work directories to hashed session roots

```bash
sed -n '1,120p' ~/.kimi/kimi.json | jq .
find ~/.kimi/sessions -maxdepth 2 -type d
```

### Inspect wire metadata and first records

```bash
sed -n '1,10p' ~/.kimi/sessions/<workdir-hash>/<session-id>/wire.jsonl | jq .
```

### Inspect the message history JSONL

```bash
awk 'NR>=1 && NR<=30' ~/.kimi/sessions/<workdir-hash>/<session-id>/context.jsonl | jq .
```

### If `metadata.json` exists, use it

```bash
sed -n '1,80p' ~/.kimi/sessions/<workdir-hash>/<session-id>/metadata.json | jq .
```

## Current Parser Comparison

- Current parser reads `context.jsonl` and optional `metadata.json`, which aligns with upstream code.
- The parser currently ignores `wire.jsonl`, but `wire.jsonl` is valuable for turn boundaries, protocol version, and subagent-like wire events.
- For Kimi, the pointer block should include both `context.jsonl` and `wire.jsonl`.

## Sources

- [MoonshotAI/kimi-cli `session.py`](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py) (accessed 2026-04-15)
- [MoonshotAI/kimi-cli `wire/file.py`](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py) (accessed 2026-04-15)


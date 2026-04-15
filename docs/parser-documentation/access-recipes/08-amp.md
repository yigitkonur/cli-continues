# Amp Access Recipes

## Raw Source

- Documented fact: Amp’s manual talks about threads, handoffs, thread references by ID or URL, `amp threads continue`, and a debug tool that can edit a thread in JSON, but it does not publish local storage paths. Source: [Amp manual](https://ampcode.com/manual) (accessed 2026-04-15).
- Observed example: this machine stores thread JSON at `~/.local/share/amp/threads/T-....json` and also has `~/.local/share/amp/history.jsonl`, plus config/state files like `session.json`, `secrets.json`, and `device-id.json`. Observed 2026-04-15.
- Observed example: sampled thread JSON has top-level keys like `id`, `created`, `messages`, `meta.traces`, and `env.initial`, while `history.jsonl` stores lightweight `{text,cwd}` rows.

## Retrieval Patterns

### Inspect a thread JSON file

```bash
find ~/.local/share/amp/threads -name 'T-*.json'
jq '{id, created, message_count:(.messages|length), env, usageLedger}' ~/.local/share/amp/threads/T-....json
```

### Pull messages 10-30 from the JSON array

```bash
jq '.messages[9:30]' ~/.local/share/amp/threads/T-....json
```

### Find text blocks inside assistant or user messages

```bash
jq -cr '
  .messages[9:30][]
  | {role, messageId, text:[.content[]? | select(.type=="text") | .text]}
' ~/.local/share/amp/threads/T-....json
```

### Use the lightweight prompt history

```bash
sed -n '1,20p' ~/.local/share/amp/history.jsonl | jq .
```

## Current Parser Comparison

- Current parser path assumption `~/.local/share/amp/threads/` matches local observation.
- The parser currently ignores `history.jsonl`, which is a cheap way to recover recent prompt text and cwd even if thread parsing fails.
- Amp docs do not currently elevate the local path to documented fact, so keep the path labeled as observed example.

## Sources

- [Amp manual](https://ampcode.com/manual) (accessed 2026-04-15)

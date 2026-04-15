# Droid Access Recipes

## Raw Source

- Documented fact: Factory CLI supports explicit session resume via `droid exec -s <id>` and interactive session browsing via `/sessions`, but its public docs do not publish the raw transcript path or format. Source: [Factory CLI reference](https://docs.factory.ai/reference/cli-reference) (accessed 2026-04-15).
- Documented fact: Factory quickstart confirms interactive sessions exist, but does not describe raw storage. Source: [Factory quickstart](https://docs.factory.ai/cli/getting-started/quickstart) (accessed 2026-04-15).
- Observed example: on this machine, Droid stores JSONL transcripts under `~/.factory/sessions/<workspace-slug>/<session-id>.jsonl` with paired `<session-id>.settings.json` files in the same directory. Observed 2026-04-15.
- Observed example: the sampled transcript starts with a `session_start` object, then `message` records whose `message.content` blocks look Anthropic-like, while the settings sidecar holds model and token usage. Observed 2026-04-15.

## Retrieval Patterns

### Find a session and inspect the first records

```bash
find ~/.factory/sessions -name '*.jsonl' | head
sed -n '1,10p' ~/.factory/sessions/<workspace>/<session>.jsonl | jq .
```

### Slice messages 10-30

```bash
awk 'NR>=10 && NR<=30' ~/.factory/sessions/<workspace>/<session>.jsonl | jq .
```

### Extract assistant tool-use blocks

```bash
jq -cr '
  select(.type=="message" and .message.role=="assistant")
  | .message.content[]?
  | select(.type=="tool_use")
' ~/.factory/sessions/<workspace>/<session>.jsonl
```

### Read the settings sidecar

```bash
sed -n '1,120p' ~/.factory/sessions/<workspace>/<session>.settings.json | jq .
```

## Current Parser Comparison

- Current parser assumptions about `.jsonl` plus `.settings.json` are strongly supported by local observation.
- The parser is using the right primary source, but the handoff pointer should mention the settings sidecar explicitly because that is where model and aggregated token usage live.
- Public Factory docs are currently too thin to treat the path itself as documented fact; keep it labeled as observed example unless Factory publishes it.

## Sources

- [Factory CLI reference](https://docs.factory.ai/reference/cli-reference) (accessed 2026-04-15)
- [Factory quickstart](https://docs.factory.ai/cli/getting-started/quickstart) (accessed 2026-04-15)


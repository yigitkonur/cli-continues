# Cursor Access Recipes

## Raw Source

- Documented fact: first-party Cursor docs for shared transcripts do not describe local raw storage. Source: [Cursor shared transcripts](https://cursor.com/help/ai-features/shared-transcripts) (accessed 2026-04-15).
- Observed example: on this machine, Cursor stores project-scoped agent transcripts under `~/.cursor/projects/<project-slug>/agent-transcripts/<session-id>.jsonl`, alongside `repo.json`, `.workspace-trusted`, and `worker.log`. Observed 2026-04-15.
- Observed example: sampled transcript rows are plain JSON objects with `role` and `message.content[]` blocks that resemble Anthropic transcript blocks.
- Unresolved: I did not find a first-party Cursor doc that confirms the `agent-transcripts` path or guarantees the JSONL schema.

## Retrieval Patterns

### Discover transcript files

```bash
find ~/.cursor/projects -path '*/agent-transcripts/*.jsonl'
```

### Slice messages 10-30

```bash
awk 'NR>=10 && NR<=30' ~/.cursor/projects/<slug>/agent-transcripts/<session>.jsonl | jq .
```

### Extract assistant tool calls or text blocks

```bash
jq -cr '
  select(.role=="assistant")
  | .message.content[]?
  | select(.type=="tool_use" or .type=="text")
' ~/.cursor/projects/<slug>/agent-transcripts/<session>.jsonl
```

### Use sidecars for repo context

```bash
sed -n '1,80p' ~/.cursor/projects/<slug>/repo.json | jq .
tail -n 50 ~/.cursor/projects/<slug>/worker.log
```

## Current Parser Comparison

- Current parser assumption about `~/.cursor/projects/*/agent-transcripts/` is supported by local observation.
- The parser currently only points to the transcript. The redesign should also expose the project slug and `repo.json` because Cursor has no native resume CLI here, so downstream navigation depends on project context as much as transcript context.
- Because first-party storage docs are missing, Cursor should stay labeled as observed/inferred rather than documented fact.

## Sources

- [Cursor shared transcripts](https://cursor.com/help/ai-features/shared-transcripts) (accessed 2026-04-15)


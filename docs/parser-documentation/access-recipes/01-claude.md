# Claude Access Recipes

## Raw Source

- Documented fact: Claude Code settings docs confirm session persistence can be disabled with `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, and old session files are cleaned up via `cleanupPeriodDays`, but the docs do not publish the transcript path directly. Source: [settings docs](https://code.claude.com/docs/en/settings) (accessed 2026-04-15).
- Documented fact, user-reported: first-party issues describe raw session files under `~/.claude/projects/` as `.jsonl`, and discuss missing or stale `sessions-index.json`. Sources: [issue #18897](https://github.com/anthropics/claude-code/issues/18897), [issue #25032](https://github.com/anthropics/claude-code/issues/25032) (accessed 2026-04-15).
- Observed example: on this machine, Claude stores transcripts as `~/.claude/projects/<project-slug>/<session-id>.jsonl` and also creates a sibling directory `~/.claude/projects/<project-slug>/<session-id>/` containing `subagents/` and sometimes `tool-results/`. Observed 2026-04-15.
- Unresolved: current first-party docs do not confirm whether `sessions-index.json` is still part of current releases, and local observation did not find any such file on this machine.

## Retrieval Patterns

### Slice messages 10-30 from the transcript

```bash
file=~/.claude/projects/<project>/<session>.jsonl
awk 'NR>=10 && NR<=30' "$file" | jq .
```

### Extract tool uses between those lines

```bash
awk 'NR>=10 && NR<=30' "$file" \
  | jq -cr '
      select(.type=="assistant" and (.message.content|type)=="array")
      | .message.content[]?
      | select(.type=="tool_use")
      | {name, id, input}
    '
```

### Find assistant messages that include edit-related tool calls

```bash
jq -cr '
  select(.type=="assistant" and (.message.content|type)=="array")
  | .message.content[]?
  | select(.type=="tool_use" and (.name|test("Write|Edit|MultiEdit|Bash")))
' "$file"
```

### Inspect subagent and external tool-result sidecars

```bash
session_dir="${file%.jsonl}"
find "$session_dir/subagents" -type f 2>/dev/null
find "$session_dir/tool-results" -type f 2>/dev/null
```

## Current Parser Comparison

- Current parser assumptions are mostly aligned on the primary transcript path and the sibling `subagents/` and `tool-results/` folders.
- The current handoff renderer only points to the main `.jsonl` file. For Claude, the pointer block should also expose the sibling session directory because subagent transcripts and oversized tool outputs live there.
- Current parser code does not rely on `sessions-index.json`, which is good because local observation did not find it, but the redesign should still mention the index uncertainty explicitly.

## Sources

- [Claude Code settings](https://code.claude.com/docs/en/settings) (accessed 2026-04-15)
- [anthropics/claude-code issue #18897](https://github.com/anthropics/claude-code/issues/18897) (accessed 2026-04-15)
- [anthropics/claude-code issue #25032](https://github.com/anthropics/claude-code/issues/25032) (accessed 2026-04-15)


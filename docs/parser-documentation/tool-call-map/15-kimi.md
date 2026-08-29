# Kimi Code CLI

## Raw storage

- Documented fact:
  - Kimi Code CLI v2 (>= 0.39) creates sessions under
    `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/`.
  - Each session directory has `state.json` and `agents/main/wire.jsonl` (a
    protocol-1.5 event log); there is no `context.jsonl` in the v2 layout.
  - `session_index.jsonl` and `workspaces.json` are the authoritative
    session/workspace registries.
- Observed example:
  - Local session directories match the
    `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/` pattern and contain
    `state.json` + `agents/main/wire.jsonl` (protocol 1.5).
- Inference:
  - `wire.jsonl` is the primary conversation source, not an optional side log.

## Tool-call encoding

- Documented fact:
  - Tool calls are recorded as `tool.call` events inside
    `context.append_loop_event`: `{toolCallId, name, args}`.
  - `args` is a JSON object (e.g. `{command, cwd}` for `Bash`), not a string.
  - Tool results are `tool.result` events with `result.output`.
  - Think blocks are `content.part` events with `part.type === "think"` and a
    `think` field.
  - `usage.record` entries carry per-turn token totals.
- Observed example:
  - Local `wire.jsonl` had `tool.call`/`tool.result` pairs inside turns, with
    `Bash`, `Read`, `Grep`, `Glob`, `Edit`, `Ask`, and `Agent` tools.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - Exact tool/function names are preserved in `tool.call.name`.
  - Tool arguments are stored as objects in `tool.call.args`.
- Inference:
  - The parser stringifies object args back into OpenAI-style
    `tool_calls[].function.arguments` for the shared tool-summary pipeline.

## What `continues` abstracts away today

- `src/parsers/kimi.ts` reads `agents/main/wire.jsonl` (protocol 1.5) and
  reconstructs user turns, assistant text/think blocks, and tool calls.
- The parser normalizes exact tool names via the shared `SummaryCollector` and
  does not surface `tool.result` output in the handoff.

## Direct-access recipe

```bash
find ~/.kimi-code/sessions -name wire.jsonl | head -n 20

sed -n '1,8p' ~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl \
  | jq -c '{keys:(keys|sort),type,eventType:(.event.type? // null)}'
```

## Sources

- Observed locally on 2026-08-28: kimi 0.39.1
  `~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`
- Official repo code: https://github.com/MoonshotAI/kimi-cli

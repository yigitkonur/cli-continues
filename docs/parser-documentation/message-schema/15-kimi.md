# Kimi Code CLI Message Schema

Access date: 2026-08-28

## Raw Schema

- Documented fact: Kimi Code CLI v2 organizes sessions under
  `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/`.
- Documented fact: The conversation is stored in `agents/main/wire.jsonl` as a
  protocol-1.5 event log (there is no `context.jsonl` in the v2 layout).
- Documented fact: `session_index.jsonl` and `workspaces.json` are the
  authoritative session/workspace registries.
- Documented fact: `state.json` v2 carries `id`, `cwd`, epoch-ms
  `createdAt`/`updatedAt`, `archived`, `title`, `lastPrompt`, `lastTurnReason`,
  and `agents.main.homedir` (the absolute path of the main agent dir containing
  `wire.jsonl`).
- Observed example: Sampled local session directories contained
  `state.json` + `agents/main/wire.jsonl` (2152 records), `tasks/*.json`, and
  `logs/kimi-code.log`.

## Wire Records (protocol 1.5)

- `metadata` — `{protocol_version, created_at}` header (epoch ms)
- `profile.bind` — `{modelAlias, profileName, systemPrompt}` (model binding)
- `turn.prompt` — user turn: `{input: [{type: "text", text}], origin: {kind:
  "user"|"task"|"injection"}, time}`; only `kind === "user"` is conversational
- `context.append_loop_event` — events within a turn:
  - `step.begin` / `step.end`
  - `content.part` — `{part: {type: "think"|"text", ...}}` assistant content
  - `tool.call` — `{toolCallId, name, args}` (args is an object, not a string)
  - `tool.result` — `{parentUuid, toolCallId, result: {output}}`
- `usage.record` — per-turn token usage `{inputOther, output, inputCacheRead,
  inputCacheCreation}`
- `turn.ended` — turn boundary
- `context.apply_compaction` / `full_compaction.begin` — full-context compaction
  markers

## User Messages

- Documented fact: user turns are recorded as `turn.prompt` with
  `origin.kind === "user"`; task-completion notifications use
  `origin.kind === "task"` and are not conversational.
- Observed example: every `turn.prompt` matched a `context.append_message`
  user record within 10s; the parser uses `turn.prompt` as the canonical
  user-turn source.

## Assistant Messages

- Documented fact: assistant text and think blocks are streamed as
  `content.part` events inside `context.append_loop_event`; tool calls are
  `tool.call` events in the same turn.
- Inference: the parser reconstructs one assistant `KimiMessage` per turn by
  merging `content.part` (text/think) blocks and `tool.call` records in order.

## Ordering, Boundaries, And State

- Documented fact: `wire.jsonl` is append-only and timestamped.
- Documented fact: `turn.ended` closes each turn; the parser flushes the open
  assistant message there.
- Documented fact: full compaction is recorded as
  `context.apply_compaction`/`full_compaction.*`; the wire log retains prior
  records, so reconstruction is unaffected (a fidelity warning is emitted).

## Direct Access

- Session directories: `find ~/.kimi-code/sessions -maxdepth 4 -type f`
- Wire log preview: `head -n 20 ~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`
- State preview: `jq . ~/.kimi-code/sessions/wd_*/session_*/state.json`

## Parser Comparison

- `src/parsers/kimi.ts` reads `agents/main/wire.jsonl` (protocol 1.5),
  `state.json` v2, `session_index.jsonl`, and `workspaces.json`.
- The legacy pre-0.39 layout (`~/.kimi/sessions/<md5>/<id>/context.jsonl` +
  `metadata.json` + v1 `state.json`) is still parsed as a fallback.

## Sources

- Observed locally on 2026-08-28: kimi 0.39.1 wire logs at
  `~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`
- Kimi session model: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py
- Kimi wire file format: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py

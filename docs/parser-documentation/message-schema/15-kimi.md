# Kimi CLI Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: Official Kimi CLI code organizes sessions under `~/.kimi/sessions/<workdir-hash>/<session-id>/`.
- Documented fact: Current session directories are expected to contain `context.jsonl`, `wire.jsonl`, and `state.json`.
- Documented fact: The official code treats `metadata.json` as legacy and migrates its fields into `state.json`.
- Documented fact: `wire.jsonl` begins with a metadata header line and then stores structured timestamped wire-message records.
- Documented fact: `context.jsonl` is still the file the official session object treats as “message history.”
- Observed example: Sampled local Kimi session directories contained `context.jsonl` and `wire.jsonl`, but the sampled `context.jsonl` files were empty.
- Observed example: Sampled `wire.jsonl` files started with `{"type":"metadata","protocol_version":"1.3"}` followed by timestamped `TurnBegin` records.

## Assistant Messages

- Documented fact: The official session code reads `context.jsonl` as JSON lines containing at least a `role` field, and treats roles not starting with `_` as conversational.
- Unresolved uncertainty: The official snippets reviewed here did not expose the full current assistant-message JSON shape inside `context.jsonl`.
- Inference: The parser’s assumed `assistant` role plus `content`, `tool_calls`, and `_usage` lines may be correct for some builds, but that exact shape was not independently confirmed from upstream code in this audit.

## User Messages

- Documented fact: User messages are also stored in `context.jsonl`; the official code checks line JSON for `role`.
- Observed example: The sampled local `wire.jsonl` `TurnBegin` payload clearly contains `user_input`, so usable user chronology may exist even when `context.jsonl` is empty.

## Ordering, Boundaries, And State

- Documented fact: `wire.jsonl` is append-only and timestamped.
- Documented fact: `state.json` now carries session title/archive/approval/todo state; `metadata.json` is legacy.
- Inference: Full Kimi reconstruction may require both `context.jsonl` and `wire.jsonl`, especially when context files are empty or partially written.

## Direct Access

- Session directories: `find ~/.kimi/sessions -maxdepth 3 -type f`
- Wire log preview: `head -n 20 ~/.kimi/sessions/<hash>/<session>/wire.jsonl`
- Context log preview: `head -n 20 ~/.kimi/sessions/<hash>/<session>/context.jsonl`

## Parser Comparison

- `src/parsers/kimi.ts` is only partially aligned with current upstream code.
- It correctly targets `~/.kimi/sessions/<hash>/<session>/context.jsonl`, but it still looks for legacy `metadata.json` and ignores current `state.json`.
- It ignores `wire.jsonl`, even though sampled local sessions had chronology there while `context.jsonl` was empty.
- This makes Kimi a high-risk assistant-message coverage problem: the parser can return little or no conversation even when the session directory still contains recoverable wire history.

## Sources

- Kimi session model: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session.py (accessed 2026-04-15)
- Kimi session state: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/session_state.py (accessed 2026-04-15)
- Kimi wire file format: https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/wire/file.py (accessed 2026-04-15)
- Observed local wire log: `~/.kimi/sessions/ac0c330c0ce4a33a0bd36cfa7edc03d5/52f9d645-ac68-42db-8e80-e6b20bc51435/wire.jsonl` (accessed 2026-04-15)

# Codex

## Documented Facts

- OpenAI documents `CODEX_HOME` as the local Codex state root, defaulting to `~/.codex`.
- The open-source Codex CLI code writes resumable rollout files under `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
- The same repo exports `experimental_resume` helpers and thread listing code that treat those rollout files as the resumable session source.
- An official discussion says session IDs are generated at session start and resume relies on the ID stored inside the JSONL, not the filename you rename later.

## Observed Example

- `src/parsers/codex.ts` reads `session_meta`, `event_msg`, `response_item`, and `turn_context` records from `rollout-*.jsonl`.
- `src/__tests__/fixtures/index.ts` creates Codex fixtures in the same rollout filename pattern and includes `session_meta` plus `event_msg` records.

## Inference

- The pointer block should name the rollout file actually parsed, even if user-facing docs also mention broader `CODEX_HOME` state such as `history.jsonl`. For handoff continuation, the rollout JSONL is the valuable artifact.

## Unresolved Uncertainty

- Official docs emphasize `history.jsonl`, while the open-source runtime centers resume and thread listing on rollout files. The safest pointer is to surface both the parsed rollout path and the broader `CODEX_HOME` root.

## Default-Mode Pointer Block

- `Session`: Codex CLI / `<session-id>`
- `Raw rollout`: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl`
- `Backend`: JSONL rollout log
- `Volume`: `<line-count>` records
- `Continue handle`: `codex -c experimental_resume="<rollout-path>"`
- `Quick inspect`: `sed -n '1,12p' <rollout>.jsonl` and `rg -n '"type":"session_meta"|"type":"response_item"|"type":"event_msg"' <rollout>.jsonl`
- `Context root`: show `CODEX_HOME` so the receiver knows where related history/config live

## Full-Mode Pointer Block

- Everything from default mode
- `Record mix`: counts of `session_meta`, `response_item`, `event_msg`, and `turn_context`
- `Shape note`: `response_item` is richer for assistant text and tool calls; `event_msg` can duplicate conversational turns
- `Focused retrieval`:
  - `jq -c 'select(.type=="session_meta")' <rollout>.jsonl | head`
  - `jq -c 'select(.type=="response_item")' <rollout>.jsonl | tail -n 20`
  - `jq -c 'select(.type=="event_msg")' <rollout>.jsonl | tail -n 20`

## Why This Is Feasible

- `continues` already stores the rollout path in `session.originalPath`, derives the session ID from the filename, and streams the JSONL in `src/parsers/codex.ts`.
- Record-type counts are cheap because the file is append-only JSONL.

## Current `continues` Comparison

- Current handoff output hides the difference between `response_item` and `event_msg`, even though that distinction matters when a receiver wants the highest-fidelity assistant/tool view.
- Current presets do not tell the receiver that the raw transcript is a rollout file nested by date.

## Sources

- Official docs: https://developers.openai.com/codex/config-advanced (accessed 2026-04-15)
- Official discussion: https://github.com/openai/codex/discussions/3827 (accessed 2026-04-15)
- First-party repo code: `openai/codex` files `codex-rs/rollout/src/lib.rs`, `codex-rs/rollout/src/list.rs`, `codex-rs/rollout/src/recorder.rs` (read 2026-04-15)
- Local parser and fixture: `src/parsers/codex.ts`, `src/__tests__/fixtures/index.ts` (read 2026-04-15)

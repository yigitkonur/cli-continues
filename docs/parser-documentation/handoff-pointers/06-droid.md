# Droid

## Documented Facts

- Factory’s official CLI docs expose session continuation by `session_id`, including `droid exec --session-id <id>` and streaming JSON/JSONL output that repeats `session_id`.
- Factory’s settings docs document `~/.factory/settings.json` as the main user settings file and `cloudSessionSync` as a session-mirroring toggle.

## Observed Example

- `src/parsers/droid.ts` assumes a local store at `~/.factory/sessions/<workspace-slug>/<uuid>.jsonl` plus a sidecar `<uuid>.settings.json`.
- The parser expects event records like `session_start`, `message`, `todo_state`, and `compaction_state`, and derives the working directory from `session_start.cwd` or the workspace slug.

## Inference

- Droid can support a useful pointer block, but it should include an explicit confidence label because first-party docs verified the session identifier and settings path more strongly than the raw on-disk session directory layout.

## Unresolved Uncertainty

- No strong first-party page was found that explicitly documents the raw `~/.factory/sessions/.../*.jsonl` layout the parser currently uses.
- The next redesign should preserve a low-confidence marker until a real local capture or first-party code/docs confirm the session store path and file schema.

## Default-Mode Pointer Block

- `Session`: Factory Droid / `<session-id>`
- `Confidence`: `observed-store` or similarly explicit wording
- `Raw transcript`: `<factory-home>/sessions/<workspace-slug>/<session-id>.jsonl`
- `Sidecar settings`: `<same-dir>/<session-id>.settings.json` when present
- `Backend`: JSONL event log + JSON settings sidecar
- `Volume`: `<event-count>` rows
- `Quick inspect`:
  - `sed -n '1,12p' <session>.jsonl`
  - `jq . <session>.settings.json`

## Full-Mode Pointer Block

- Everything from default mode
- `Event mix`: counts of `session_start`, `message`, `todo_state`, and `compaction_state`
- `Recovery note`: Factory docs guarantee `session_id` continuation, even if the local file layout is still only observed
- `Focused retrieval`:
  - `rg -n '"type":"message"|"type":"todo_state"|"type":"compaction_state"' <session>.jsonl`
  - `jq '{model,tokenUsage,assistantActiveTimeMs}' <session>.settings.json`

## Why This Is Feasible

- `continues` already stores the JSONL path and deterministically derives the settings sidecar path.
- Event counts and quick retrieval commands are straightforward once the file is present.

## Current `continues` Comparison

- Current handoff output can summarize conversation, todos, and tool usage, but it does not tell the receiver where the `.settings.json` sidecar lives or that the storage-path claim is parser-observed rather than publicly documented.

## Sources

- Official CLI reference: https://docs.factory.ai/reference/cli-reference (accessed 2026-04-15)
- Official exec overview: https://docs.factory.ai/cli/droid-exec/overview (accessed 2026-04-15)
- Official settings docs: https://docs.factory.ai/cli/configuration/settings (accessed 2026-04-15)
- Local parser: `src/parsers/droid.ts` (read 2026-04-15)

# Amp

## Documented Facts

- Amp’s first-party manual and streaming JSON docs are thread-centric: they expose thread IDs like `T-...`, show `amp threads continue`, and document streamed JSON containing `session_id`, `cwd`, tools, and usage.
- Amp’s manual documents configuration and OAuth paths, but no strong first-party page in this research pass documented a local raw thread file store equivalent to the parser’s `threads/*.json`.

## Observed Example

- `src/parsers/amp.ts` assumes `~/.local/share/amp/threads/<id>.json`.
- Local fixtures in `test-fixtures/amp/threads/` show a JSON object with `id`, `created`, `messages[]`, `usageLedger.events[]`, and `env.initial.tags[]`.

## Inference

- Amp’s pointer block should expose both the local thread file path and the web/thread identity when available, but it should mark the local file layout as observed rather than documented.

## Unresolved Uncertainty

- First-party docs were sufficient to verify thread IDs and continuation flows, but not the local `threads/*.json` store the parser reads.

## Default-Mode Pointer Block

- `Session`: Amp / `<thread-id>`
- `Confidence`: `observed-local-json`
- `Raw local thread`: `~/.local/share/amp/threads/<thread-id>.json`
- `Web thread`: `https://ampcode.com/threads/<thread-id>` when the ID is URL-safe
- `Backend`: JSON thread object
- `Volume`: `<message-count>` messages
- `Quick inspect`: `jq '{id,created,messages:(.messages|length)}' <thread>.json`

## Full-Mode Pointer Block

- Everything from default mode
- `Usage ledger`: include whether `usageLedger.events` exists and how many events it contains
- `Model hint`: expose `env.initial.tags` model tag when present
- `Focused retrieval`:
  - `jq '.messages[-6:]' <thread>.json`
  - `jq '.usageLedger.events' <thread>.json`
- `Caveat`: say that official docs strongly validate web/thread continuation, but not the local JSON storage path

## Why This Is Feasible

- The parser already reads the JSON thread file, counts messages, and extracts model/tokens from `usageLedger`.
- The web thread URL is directly derivable from the thread ID when the ID uses Amp’s public `T-...` form.

## Current `continues` Comparison

- Current handoff output can show recent messages, but it does not expose the thread JSON path or tell the receiver that local storage is parser-observed while thread continuation is first-party documented.

## Sources

- Official manual: https://ampcode.com/manual (accessed 2026-04-15)
- Official streaming JSON docs: https://ampcode.com/news/streaming-json (accessed 2026-04-15)
- First-party thread example: https://ampcode.com/threads/T-39dc399d-08cc-4b10-ab17-e6bac8badea7 (accessed 2026-04-15)
- Local parser and fixtures: `src/parsers/amp.ts`, `test-fixtures/amp/threads/test-thread-1.json` (read 2026-04-15)

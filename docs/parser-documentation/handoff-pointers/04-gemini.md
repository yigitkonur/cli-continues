# Gemini

## Documented Facts

- The current upstream Gemini CLI repo records chats in append-only JSONL files created under a project-specific temp directory’s `chats/` folder.
- The same service writes metadata records and message records incrementally and can migrate older `.json` conversations into `.jsonl`.
- A first-party discussion about chat save/resume still references project-temp JSON artifacts and older checkpoint-style JSON files under `~/.gemini/tmp`.

## Observed Example

- `src/parsers/gemini.ts` still parses older single-file JSON session objects from `~/.gemini/tmp/*/chats/session-*.json` and `~/.gemini/sessions/*.json`.
- `src/__tests__/fixtures/index.ts` generates Gemini fixtures in that older single-JSON-object shape with a `messages[]` array.

## Inference

- Gemini needs a mandatory `storage variant` field in the pointer block.
- The redesign should not present a single canonical raw format until parser support catches up with the current upstream JSONL recorder.

## Unresolved Uncertainty

- The exact user-visible coexistence rules between current JSONL chat logs, older single-file JSON sessions, and saved checkpoint JSON exports are not cleanly documented in one first-party place.
- Current `continues` is still wired to the older JSON session format, so a fully accurate pointer block for current Gemini CLI data is not yet feasible from the repo alone.

## Default-Mode Pointer Block

- `Session`: Gemini CLI / `<session-id>`
- `Storage variant`: one of `current JSONL chat log`, `legacy JSON session file`, or `unknown`
- `Raw path`: actual file path that was parsed
- `Backend`: `JSONL` or `JSON`
- `Volume`: `<record-count>` or `<message-count>`
- `Quick inspect`: variant-specific command
  - JSONL: `sed -n '1,12p' <chat>.jsonl`
  - JSON: `jq '.messages[:5]' <session>.json`
- `Confidence`: `high` only when the variant was positively detected; otherwise `legacy-parser path`

## Full-Mode Pointer Block

- Everything from default mode
- `Project key`: temp/project hash directory that contains the chat file
- `Shape note`:
  - current JSONL: append-only metadata + message records
  - legacy JSON: one object with `sessionId`, timestamps, and `messages[]`
- `Focused retrieval`:
  - JSONL: `rg -n '"type":"user"|"type":"gemini"|toolCalls|thoughts' <chat>.jsonl`
  - JSON: `jq '.messages[] | {type,id,timestamp}' <session>.json | head -n 20`
- `Parser caveat`: current `continues` parser is legacy-oriented

## Why This Is Feasible

- Variant detection is cheap from filename and first record shape.
- Once detected, both JSON and JSONL backends support straightforward counts and inspect commands.
- What is not feasible today is claiming that the current repo parser already covers the upstream JSONL recorder.

## Current `continues` Comparison

- Current handoff generation assumes the older JSON session object and therefore cannot honestly surface the upstream recorder shape or its append-only semantics.
- This is one of the clearest cases where a pointer block needs a `variant` and `confidence` field rather than a single normalized story.

## Sources

- First-party repo code: `google-gemini/gemini-cli` files `packages/core/src/services/chatRecordingService.ts` and `packages/core/src/config/storage.ts` (read 2026-04-15)
- First-party discussion: https://github.com/google-gemini/gemini-cli/discussions/4974 (accessed 2026-04-15)
- Local parser and fixture: `src/parsers/gemini.ts`, `src/__tests__/fixtures/index.ts` (read 2026-04-15)

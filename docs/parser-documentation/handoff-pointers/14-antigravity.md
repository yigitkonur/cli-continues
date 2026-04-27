# Antigravity

## Documented Facts

- Current upstream Gemini CLI code exposes tracker storage under a project temp/session directory, with JSON task files under a `tracker/` subdirectory.
- No strong first-party source from this pass confirmed the older `~/.gemini/antigravity/code_tracker/` line-log format that `continues` currently parses.

## Observed Example

- `src/parsers/antigravity.ts` reads `~/.gemini/antigravity/code_tracker/` and strips binary/protobuf prefixes from each line before parsing JSON objects with `type`, `content`, and `timestamp`.
- Local fixtures under `test-fixtures/antigravity/code_tracker/` include both plain JSONL and binary-prefixed lines in that legacy shape.

## Inference

- Antigravity needs the strongest possible `variant + confidence` treatment in the redesign.
- The pointer block should not pretend the parser’s legacy `code_tracker` format is the settled upstream truth.

## Unresolved Uncertainty

- Whether current Antigravity installs still emit `code_tracker` conversation logs, or whether that format has effectively been superseded by newer tracker JSON under Gemini’s temp/session tree.

## Default-Mode Pointer Block

- `Session`: Antigravity / `<session-id>`
- `Storage variant`: `legacy code_tracker line log` or `unknown`
- `Confidence`: `low` unless the raw file was directly observed
- `Raw path`: actual file parsed by the session indexer
- `Backend`: `binary-prefixed JSONL-ish line log`
- `Volume`: `<line-count>` relevant user/assistant entries
- `Quick inspect`: `perl -pe 's/^[^{]*//' <file> | sed -n '1,12p'`

## Full-Mode Pointer Block

- Everything from default mode
- `Shape note`: each line is expected to reduce to `{type, content, timestamp}`
- `Focused retrieval`:
  - `perl -pe 's/^[^{]*//' <file> | jq -c '.' | head -n 20`
  - `rg -n '"type": "user"|"type": "assistant"' <file>`
- `Upstream mismatch`: note that current Gemini repo evidence points to newer tracker JSON under temp/session directories rather than `code_tracker`

## Why This Is Feasible

- The current parser already knows how to detect and strip the prefix bytes and count entries.
- What is not feasible is claiming high confidence that this is the current upstream storage layout.

## Current `continues` Comparison

- Current handoff output treats Antigravity as a simple user/assistant text log, but the bigger issue is backend confidence, not message rendering.
- This tool should get a pointer block that foregrounds uncertainty instead of smoothing it away.

## Sources

- First-party repo code: `google-gemini/gemini-cli` files `packages/core/src/services/trackerService.ts` and `packages/core/src/config/storage.ts` (read 2026-04-15)
- Local parser and fixtures: `src/parsers/antigravity.ts`, `test-fixtures/antigravity/code_tracker/test-project/session.jsonl`, `test-fixtures/antigravity/code_tracker/test-project/session-binary.jsonl` (read 2026-04-15)

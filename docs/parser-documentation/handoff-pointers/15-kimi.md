# Kimi

## Documented Facts

- Official Kimi docs are unusually strong here: all runtime data lives under `~/.kimi/` unless `KIMI_SHARE_DIR` overrides it.
- Official docs publish the full session directory layout:
  - `sessions/<work-dir-hash>/<session-id>/context.jsonl`
  - `wire.jsonl`
  - `state.json`
  - `subagents/<agent_id>/...`
- Official docs also explain what each file means and that `context.jsonl` is used for `--continue` / `--session`.

## Observed Example

- `src/parsers/kimi.ts` matches that official shape closely, including hashed work-dir directories, optional `metadata.json` handling, and `context.jsonl` parsing.

## Inference

- Kimi deserves a rich pointer block even in default mode because the official docs make retrieval mechanics explicit and the parser already aligns with them.

## Unresolved Uncertainty

- None that block a strong pointer block. The main nuance is that `_usage` records expose a total token count snapshot rather than a full input/output split.

## Default-Mode Pointer Block

- `Session`: Kimi / `<session-id>`
- `Raw session dir`: `~/.kimi/sessions/<work-dir-hash>/<session-id>/`
- `Primary files`: `context.jsonl`, `wire.jsonl`, `state.json`
- `Backend`: JSONL context + JSON state
- `Volume`: `<context-line-count>` lines
- `Quick inspect`:
  - `sed -n '1,12p' <session-dir>/context.jsonl`
  - `jq . <session-dir>/state.json`

## Full-Mode Pointer Block

- Everything from default mode
- `Subagents`: include `subagents/` count and path when present
- `State note`: surface key fields from `state.json` such as approval mode, plan mode, additional dirs, and subagent instances when cheap
- `Focused retrieval`:
  - `rg -n '"role": "_usage"|"role": "assistant"|"role": "user"' <session-dir>/context.jsonl`
  - `find <session-dir>/subagents -maxdepth 2 -type f | sort`
  - `sed -n '1,12p' <session-dir>/wire.jsonl`

## Why This Is Feasible

- `continues` already knows the session directory and parses `context.jsonl`.
- `wire.jsonl`, `state.json`, and `subagents/` are deterministic siblings documented by the upstream tool itself.

## Current `continues` Comparison

- Current handoff output exposes only the parsed conversation and tool summary, not the equally important `wire.jsonl`, `state.json`, or subagent directory that the official tool treats as part of session restoration.

## Sources

- Official docs: https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html (accessed 2026-04-15)
- First-party repo code: `MoonshotAI/kimi-cli` files `docs/en/configuration/data-locations.md`, `src/kimi_cli/session.py`, `src/kimi_cli/session_state.py`, and `src/kimi_cli/metadata.py` (read 2026-04-15)
- Local parser: `src/parsers/kimi.ts` (read 2026-04-15)

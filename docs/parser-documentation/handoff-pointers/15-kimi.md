# Kimi

## Documented Facts

- Official Kimi docs describe the share-dir layout for the current CLI:
  all runtime data lives under `~/.kimi-code/` unless `KIMI_CODE_HOME`
  overrides it (pre-0.39 builds used `~/.kimi/` with `KIMI_SHARE_DIR`).
- Official docs publish the full session directory layout:
  - `sessions/wd_<name>_<hash>/session_<uuid>/state.json`
  - `agents/main/wire.jsonl`
  - `agents/main/tasks/*.json`
- `session_index.jsonl` maps `{sessionId, sessionDir, workDir}`; the parser
  uses it as the authoritative session list with a directory-scan fallback.

## Observed Example

- `src/parsers/kimi.ts` matches the current shape: v2 `state.json`,
  `agents/main/wire.jsonl` (protocol 1.5), `session_index.jsonl`, and
  `workspaces.json` cwd resolution; the legacy `~/.kimi` md5 layout remains a
  fallback.

## Inference

- Kimi deserves a rich pointer block even in default mode because the official
  docs make retrieval mechanics explicit and the parser aligns with them.

## Unresolved Uncertainty

- None that block a strong pointer block. The main nuance is that `usage.record`
  exposes per-turn token totals rather than a full input/output split.

## Default-Mode Pointer Block

- `Session`: Kimi Code CLI / `<session-id>`
- `Raw session dir`: `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/`
- `Primary files`: `state.json`, `agents/main/wire.jsonl`
- `Backend`: JSONL wire log + JSON state
- `Volume`: `<wire-line-count>` lines
- `Quick inspect`:
  - `jq . <session-dir>/state.json`
  - `sed -n '1,12p' <session-dir>/agents/main/wire.jsonl`

## Full-Mode Pointer Block

- Everything from default mode
- `Subagents`: include `agents/agent-N/wire.jsonl` count and paths when present
- `State note`: surface key fields from `state.json` such as `cwd`, `archived`,
  `lastTurnReason`, and `agents.main.homedir` when cheap
- `Focused retrieval`:
  - `rg -n '"type": "turn.prompt"|"type": "content.part"|"type": "tool.call"' <session-dir>/agents/main/wire.jsonl`
  - `find <session-dir>/agents -maxdepth 2 -type f | sort`
  - `sed -n '1,12p' <session-dir>/agents/main/wire.jsonl`

## Why This Is Feasible

- `continues` already knows the session directory and parses
  `agents/main/wire.jsonl`.
- `state.json`, `tasks/`, and subagent dirs are deterministic siblings written
  by the upstream tool itself.

## Current `continues` Comparison

- Current handoff output exposes the parsed conversation and tool summary; the
  raw `wire.jsonl`, `state.json`, and subagent directories are also available
  via `sourceMetadata` and `rawAccess`.

## Sources

- Observed locally on 2026-08-28: kimi 0.39.1 `~/.kimi-code/` layout
- Official docs: https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html (accessed 2026-04-15)
- Official repo code: https://github.com/MoonshotAI/kimi-cli

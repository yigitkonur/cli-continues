# Kimi Code CLI

Accessed: 2026-08-28

## Documented Fact

- Share/session root:
  - `KIMI_CODE_HOME`, default `~/.kimi-code` (v2, >= 0.39)
  - legacy `KIMI_SHARE_DIR`, default `~/.kimi` (pre-0.39, still read as fallback)
- Global metadata files:
  - `~/.kimi-code/session_index.jsonl` — authoritative session index
    (`{sessionId, sessionDir, workDir}` per line)
  - `~/.kimi-code/workspaces.json` — maps `wd_<name>_<hash>` session roots to
    `{root, name, created_at, last_opened_at}`
- Session directory layout:
  - `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/`
- Per-session files:
  - `state.json` (v2: `{id, version, cwd, createdAt, updatedAt, archived,
    agents.main.homedir, title, lastPrompt, lastTurnReason}`)
  - `agents/main/wire.jsonl` — protocol 1.5 wire log (conversation source)
  - `agents/main/tasks/*.json`, `agents/main/blobs/`, `logs/kimi-code.log`
- Session-ID location:
  - directory name `session_<uuid>`
  - recorded as `id` in `state.json`
- Resume/list behavior:
  - sessions are tracked per workspace directory
  - `--continue` resumes the latest session in the current working directory
  - `--session` / `-S` resume a specific session ID
- Export behavior:
  - `kimi export` zips the full session directory

## Append/Update Behavior

- `session_index.jsonl` is the authoritative index, updated as sessions are created
- `wire.jsonl` is an append-only event log (metadata header + typed records)
- `state.json` is mutable session state and is rewritten as session settings change
- Session directories are created eagerly per session

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/kimi.ts` target
  `~/.kimi-code/sessions/` with the `session_index.jsonl` index, `workspaces.json`
  root resolution, v2 `state.json`, and `agents/main/wire.jsonl` conversation.
- Gaps:
  - legacy `~/.kimi` md5 layout is only a fallback for pre-0.39 sessions
  - subagent (`agents/agent-N/wire.jsonl`) conversations are not merged into the
    main session context

## Direct Access Recipe

- Global session index:
  - `~/.kimi-code/session_index.jsonl`
- Workspace roots:
  - `~/.kimi-code/workspaces.json`
- Session root:
  - `~/.kimi-code/sessions/wd_<name>_<hash>/session_<uuid>/`
- Inspect:
  - `state.json`
  - `agents/main/wire.jsonl`

## Sources

- Observed locally on 2026-08-28: kimi 0.39.1 `~/.kimi-code/` layout with
  `session_index.jsonl`, `workspaces.json`, v2 `state.json`, and
  `agents/main/wire.jsonl` (protocol 1.5)
- Official docs: https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html
- Official repo code: https://github.com/MoonshotAI/kimi-cli

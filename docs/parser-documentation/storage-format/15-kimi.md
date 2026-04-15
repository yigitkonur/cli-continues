# Kimi CLI

Accessed: 2026-04-15

## Documented Fact

- Share/session root:
  - `KIMI_SHARE_DIR`, default `~/.kimi`
- Global metadata file:
  - `~/.kimi/kimi.json`
- Session directory layout:
  - `~/.kimi/sessions/<workdir-hash-or-kaos_hash>/<session-id>/`
- Per-session files:
  - `context.jsonl`
  - `wire.jsonl`
  - `state.json`
  - `subagents/`
- Legacy file:
  - `metadata.json` is migrated into `state.json`
- Session-ID location:
  - directory name `<session-id>`
  - created as a UUID by default
- Resume/list behavior:
  - sessions are tracked per working directory
  - `--continue` resumes the latest session in the current working directory
  - `--session` / `--resume` resume a specific session ID
- Export behavior:
  - `kimi export` zips the full session directory, including `context.jsonl`, `wire.jsonl`, `state.json`, and logs

## Append/Update Behavior

- `context.jsonl` is the persisted message-history log
- `wire.jsonl` is a second JSONL log for wire-format records
- `state.json` is mutable session state and is rewritten as session settings change
- Session directories are created eagerly per session

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/kimi.ts` are broadly correct about `~/.kimi/sessions/` and the hashed-per-workdir session structure.
- Gaps:
  - registry omits `KIMI_SHARE_DIR`
  - parser focuses on `context.jsonl` and mostly ignores `wire.jsonl` and `state.json`
  - parser still mentions optional `metadata.json`, which is now a legacy migration input

## Direct Access Recipe

- Global map of workdirs to last sessions:
  - `~/.kimi/kimi.json`
- Session root:
  - `~/.kimi/sessions/<hash>/<session-id>/`
- Inspect:
  - `context.jsonl`
  - `wire.jsonl`
  - `state.json`

## Sources

- Official docs: https://www.kimi.com/code/docs/en/kimi-cli/guides/sessions.html
- Official docs: https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html
- Official repo code: https://github.com/MoonshotAI/kimi-cli


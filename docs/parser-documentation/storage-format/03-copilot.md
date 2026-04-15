# GitHub Copilot CLI

Accessed: 2026-04-15

## Documented Fact

- Default config root: `~/.copilot`
- Overrides:
  - `COPILOT_HOME`
  - `--config-dir` takes precedence over `COPILOT_HOME`
- Session history root: `~/.copilot/session-state/`
- Per-session layout: `session-state/<session-id>/`
- Exact documented file inside each session directory: `events.jsonl`
- Additional documented contents: workspace artifacts such as plans, checkpoints, and tracked files
- Secondary store: `~/.copilot/session-store.db`
- Formats:
  - Session files: JSONL
  - Session store: SQLite
- Session-ID location:
  - Directory name
  - Also surfaced via `/session`, `--resume SESSION-ID`, and at interactive exit
- Append/update behavior:
  - Session data is written incrementally, periodically during the session, and when the session ends
  - `session-store.db` can be rebuilt from the history files via `/chronicle reindex`

## Inference

- `session-store.db` is an index/cache layer, not the authoritative resume substrate, because GitHub explicitly documents rebuilding it from `session-state/`.

## Unresolved Uncertainty

- First-party docs confirm `events.jsonl`, but they do not publicly document `workspace.yaml`; that filename remains a local parser assumption.

## Comparison Against `continues`

- Registry: `src/parsers/registry.ts` captures `~/.copilot/session-state/` but omits `COPILOT_HOME`, `--config-dir`, and `session-store.db`.
- Parser: `src/parsers/copilot.ts` expects `workspace.yaml` and `events.jsonl`.
- Gap: parser behavior may still work for current installs, but only `events.jsonl` is externally documented; the parser also ignores the SQLite session store and reindex semantics.

## Direct Access Recipe

- Session event log: `~/.copilot/session-state/<session-id>/events.jsonl`
- Session index/search DB: `~/.copilot/session-store.db`
- Rebuild index after filesystem-only restore: `/chronicle reindex`

## Sources

- Official docs: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- Official docs: https://docs.github.com/en/copilot/how-tos/copilot-cli/chronicle
- Official docs: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference


# Copilot

## Documented Facts

- GitHub documents `~/.copilot` as the default Copilot CLI config/state root, overridable by `COPILOT_HOME` or `--config-dir`.
- The same docs say `session-state/` stores session history and workspace data, with each session in its own directory containing `events.jsonl` plus workspace artifacts.
- GitHub also documents `session-store.db` as a SQLite store for cross-session indexing/search.
- GitHub’s session-data guide says sessions resume by session ID and `/session` exposes the active session ID and path details.

## Observed Example

- `src/parsers/copilot.ts` reads `<session-dir>/workspace.yaml` and `<session-dir>/events.jsonl`.
- `src/__tests__/fixtures/index.ts` generates a Copilot fixture with `workspace.yaml` and event records like `session.start`, `user.message`, and `assistant.message`.

## Inference

- Copilot’s pointer block should be directory-centric, not file-centric: the handoff receiver needs the session directory, `events.jsonl`, `workspace.yaml`, and awareness that `session-store.db` exists outside the per-session folder.

## Unresolved Uncertainty

- None that block a strong pointer block. The main limitation is current `continues` only parses `workspace.yaml` and `events.jsonl`; it does not leverage `session-store.db`.

## Default-Mode Pointer Block

- `Session`: GitHub Copilot CLI / `<session-id>`
- `Raw session dir`: `<COPILOT_HOME>/session-state/<session-id>/`
- `Primary files`: `workspace.yaml`, `events.jsonl`
- `Backend`: YAML + JSONL
- `Volume`: `<event-line-count>` event rows
- `Quick inspect`:
  - `sed -n '1,40p' <session-dir>/workspace.yaml`
  - `sed -n '1,12p' <session-dir>/events.jsonl`
- `Resume handle`: `copilot --resume <session-id>`

## Full-Mode Pointer Block

- Everything from default mode
- `Cross-session index`: `<COPILOT_HOME>/session-store.db`
- `Workspace artifacts`: call out plans/checkpoints/tracked files when present in the session directory
- `Event mix`: counts of `session.start`, `user.message`, `assistant.message`, and other non-conversation events
- `Focused retrieval`:
  - `rg -n '"type":"assistant.message"|"type":"user.message"' <session-dir>/events.jsonl`
  - `sqlite3 <COPILOT_HOME>/session-store.db '.tables'`

## Why This Is Feasible

- `continues` already has the session directory in `session.originalPath`.
- Event count is already tracked from `events.jsonl`, and `workspace.yaml` lives at a fixed sibling path.

## Current `continues` Comparison

- Current handoff text can mention the session directory, but it does not explicitly tell the receiver that the raw session is a folder with both YAML and JSONL, nor that a separate SQLite index exists.
- Tool activity today is derived only from `assistant.message.toolRequests`, so the pointer block should not imply tool-result fidelity.

## Sources

- Official docs: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference (accessed 2026-04-15)
- Official session guide: https://docs.github.com/en/copilot/how-tos/copilot-cli/chronicle (accessed 2026-04-15)
- Local parser and fixture: `src/parsers/copilot.ts`, `src/__tests__/fixtures/index.ts` (read 2026-04-15)

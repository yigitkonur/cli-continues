# Storage Format Overview

Accessed: 2026-04-15

This folder compares `continues` storage assumptions against upstream evidence for every canonical tool in `src/types/tool-names.ts`.

## Highest-Risk Mismatches

| Tool | Current `continues` assumption | Upstream evidence | Risk |
| --- | --- | --- | --- |
| Gemini | `src/parsers/gemini.ts` expects monolithic `.json` session files under `~/.gemini/tmp/*/chats/` and legacy `~/.gemini/sessions/*.json`. | Current `google-gemini/gemini-cli` writes JSONL append logs under `~/.gemini/tmp/<project-id>/chats/`, with metadata lines, `$set` updates, and `$rewindTo` records. | Very high |
| Qwen Code | Registry advertises `QWEN_HOME`; parser scans `~/.qwen/projects/*/chats/*.jsonl`. | Current `QwenLM/qwen-code` uses `QWEN_RUNTIME_DIR` as the runtime-root override. Session storage is built under `runtimeBaseDir/projects/<sanitized-cwd>/chats/`. | High |
| Kiro | Registry/parser target macOS app-support JSON files in `~/Library/Application Support/Kiro/workspace-sessions/`. | Current first-party Kiro CLI docs describe a local SQLite session database under `~/.kiro/`, UUID session IDs, and autosave-on-every-turn. Public IDE docs do not document `workspace-sessions`. | Very high |
| Crush | Registry/parser assume `~/.crush/crush.db`. | Current `charmbracelet/crush` defaults session DBs to project-local `.crush/crush.db`; global XDG paths are for config/cache/data JSON, not the per-workspace session DB. | Very high |
| Amp | Registry/parser assume `~/.local/share/amp/threads/*.json` via `XDG_DATA_HOME`. | Official Amp docs and an official public thread show settings under `~/.config/amp`, local `history.jsonl`, `session.json`, and `threads/`; only secrets are documented under `~/.local/share/amp/secrets.json`. | Very high |
| Kilo Code | Registry/parser treat VS Code `globalStorage/.../tasks/ui_messages.json` as the live store. | Current `Kilo-Org/kilocode` codebase uses XDG data storage and a SQLite DB (`kilo.db`); VS Code `tasks/` now appears in legacy-migration code, not the current runtime path. | Very high |
| Antigravity | Registry/parser now target `~/.gemini/antigravity/`, with discovery from `conversations/*.pb`, `brain/<id>/`, state summaries, and optional live RPC. | Third-party sync tooling and local evidence point to `.pb` plus brain artifacts; `code_tracker/` remains legacy-only. | Medium |
| Copilot | Registry/parser model only `~/.copilot/session-state/`. | First-party docs add `COPILOT_HOME` / `--config-dir`, `session-store.db`, incremental writes, and reindex behavior. | Medium |

## Lower-Risk But Important Gaps

- Claude: the registry/path assumption is broadly correct, but `continues` does not account for `tool-results/`, `file-history/`, or session-persistence disable switches.
- Codex: rollout discovery is mostly correct, but the registry collapses several distinct stores into one label: date-partitioned rollout JSONL files, global `history.jsonl`, logs, and SQLite-backed state.
- OpenCode: parser behavior is closer to reality than the registry text. The registry points at legacy `storage/`, but current OpenCode storage is primarily SQLite (`opencode.db`) with JSON only as a migration/fallback layer.
- Cursor: transcript discovery is directionally correct, but official/community evidence suggests transcript files are not the whole story; IDE-side state can still determine whether history appears in the UI.
- Roo Code: task-folder parsing is still relevant, but the parser ignores `history_item.json`, `_index.json`, and the extension’s `customStoragePath` override.

## Redesign Implications

1. Stop treating registry `storagePath` as canonical truth.
   It is often only a help string, and for several tools it now points at legacy or incomplete storage roots.

2. Separate “session transcript store” from “auxiliary state”.
   Codex, Copilot, Claude, Amp, and Cursor all have meaningful side stores outside the primary transcript file.

3. Distinguish append logs from mutable stores.
   Gemini, Codex, Kimi, and likely Amp use append-oriented logs; OpenCode, Crush, Kilo, Kiro CLI, and Copilot’s session store include mutable database/index state.

4. Record env-var and CLI overrides explicitly.
   Missing or stale override support is a recurring failure mode: `COPILOT_HOME`, `QWEN_RUNTIME_DIR`, `OPENCODE_DB`, `KIMI_SHARE_DIR`, and the various “disable persistence” switches are parser-relevant.

5. Treat legacy formats as legacy.
   Gemini `.json`, OpenCode file storage, Kilo VS Code task folders, and older Kimi metadata files should be documented as migration/fallback paths, not default reality.

## Suggested Pointer Block Fields

Every future handoff pointer block should expose:

- `storage_root`
- `session_locator`
- `session_id_source`
- `primary_format`
- `append_or_mutable`
- `env_or_flag_overrides`
- `auxiliary_state_paths`
- `direct_access_recipe`
- `confidence`

## Coverage Notes

- Strongest evidence: Codex, Gemini, OpenCode, Crush, Kimi, Qwen Code, Copilot.
- Most uncertain: Factory Droid, Cursor full-fidelity recovery, Kiro IDE specifically, Antigravity, Amp per-thread file schema.
- See `99-open-questions.md` for unresolved items that still matter for parser redesign.

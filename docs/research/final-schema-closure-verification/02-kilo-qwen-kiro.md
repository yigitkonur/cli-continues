# Kilo Code, Qwen Code, and Kiro Closure Pass

## Summary

- `Kilo Code`: first-party evidence now strongly favors a DB-backed OpenCode-derived runtime as the canonical live store, centered on `kilo.db`.
- `Qwen Code`: current first-party code and docs close the `projects/` vs `tmp/` question in favor of `projects/.../chats/*.jsonl` as the primary transcript store.
- `Kiro`: current first-party docs clearly split normal CLI SQLite storage from ACP `.json` + `.jsonl` sessions.

## New Confirmations

### Kilo Code

- first-party repo code hardcodes `kilo.db` as the DB filename under the app data root unless overridden
- first-party schema code defines SQLite tables for `session`, `message`, `part`, `todo`, and `permission`
- legacy VS Code task-folder artifacts appear in explicit migration flows, not current runtime persistence

### Qwen Code

- first-party docs now explicitly say session data is project-scoped JSONL under `~/.qwen/projects/<sanitized-cwd>/chats`
- first-party code confirms `QWEN_RUNTIME_DIR` precedence for the runtime base
- first-party code clarifies `tmp/` and `history/` as auxiliary rather than primary session storage

### Kiro

- official docs explicitly state normal CLI chat uses a SQLite database under `~/.kiro/`
- official ACP docs explicitly state ACP persistence under `~/.kiro/sessions/cli/` as `.json` + `.jsonl`

## New Contradictions

- treating Kilo’s old VS Code transcript/task files as the current canonical live store is no longer defensible
- treating Qwen’s `tmp/` as a possible current primary transcript store is no longer defensible from current first-party evidence
- treating Kiro normal CLI chat as `workspace-sessions/*.json` is contradicted by current public CLI docs

## Still Unresolved

- exact Kiro normal-chat SQLite filename
- exact Kiro normal-chat SQLite schema
- whether `workspace-sessions/*.json` is still a live IDE-private implementation detail anywhere
- whether `ui_messages.json` is actively written in any current Kilo shipping surface, though the strongest evidence now points elsewhere

## URLs

- https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/storage/db.ts
- https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/session/session.sql.ts
- https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-vscode/src/legacy-migration/migration-service.ts
- https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-vscode/src/legacy-migration/sessions/migrate.ts
- https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-vscode/src/legacy-migration/sessions/lib/legacy-conversation.ts
- https://github.com/Kilo-Org/kilocode/blob/main/README.md
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/storage.ts
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/sessionService.ts
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts
- https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
- https://kiro.dev/docs/cli/chat/session-management/
- https://kiro.dev/docs/cli/acp/
- https://kiro.dev/docs/chat/
- https://kiro.dev/docs/cli/reference/cli-commands/
- https://kiro.dev/changelog/cli/

# Open Questions

## Highest-Priority Questions

### Kiro: which product surface does the parser target?

- Current parser targets `~/Library/Application Support/Kiro/workspace-sessions/*.json`.
- Current first-party Kiro CLI docs describe `~/.kiro/` SQLite-backed auto-save plus JSON save/load commands.
- Action: verify a current Kiro install with active sessions and identify whether the macOS JSON layout still exists for the IDE or whether the parser is stale.

### Antigravity: can offline `.pb` transcript decoding be supported safely?

- Parser now treats `code_tracker` as legacy-only and discovers current sessions from `.pb`, brain artifacts, state summaries, and optional live RPC.
- Action: find first-party protobuf/decryption documentation before adding offline full-transcript extraction from `conversations/*.pb`.

### Qwen Code: which root is current, `projects/` or `tmp/`?

- Current parser targets `.qwen/projects/*/chats/*.jsonl`.
- First-party repo code points at `~/.qwen/tmp/<project>/chats/`.
- First-party issue discussion also references `~/.qwen/history/<project_hash>/` and `~/.qwen/tmp/<project_hash>/`.
- Action: verify against a current local install with real chat data.

### Gemini: should the parser pivot to JSONL?

- Current parser matches observed local JSON blobs.
- Current upstream repo code writes JSONL chat records.
- Action: detect format version at runtime and support both, rather than betting on one.

### Kilo Code: extension storage or CLI session manager?

- Current parser assumes a VS Code extension task layout similar to Roo/Cline.
- First-party Kilo docs emphasize CLI session persistence, JSON export/import, and architecture around `packages/opencode/`.
- Action: confirm whether `kilo-code` in this repo is meant to parse the editor extension, the CLI, or both.

## Medium-Priority Questions

### Codex: which secondary artifacts should be pointerized by default?

- Local installs include rollout JSONL, `session_index.jsonl`, `history.jsonl`, `archived_sessions/`, and a state SQLite DB.
- Action: decide whether the pointer block should always include the state DB path or only when a session has spawn edges / archival context.

### Copilot: should the redesign expose rewind snapshots?

- Local sessions include `rewind-snapshots/index.json`.
- Action: decide whether checkpoint/rewind metadata belongs in the pointer block or only in full mode.

### Claude: is `sessions-index.json` still a live concern?

- Multiple first-party issues discuss it.
- Local observation on this machine found no `sessions-index.json` at all.
- Action: verify against a clean current Claude install before assuming the resume index still exists.

## Sources

- [Kiro session management docs](https://kiro.dev/docs/cli/chat/session-management/) (accessed 2026-04-15)
- [Qwen issue #2373](https://github.com/QwenLM/qwen-code/issues/2373) (accessed 2026-04-15)
- [google-gemini/gemini-cli `chatRecordingService.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts) (accessed 2026-04-15)
- [Antigravity docs root](https://antigravity.google/docs) (accessed 2026-04-15)

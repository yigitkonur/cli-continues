# Consolidated Open Questions

Access date: 2026-04-15

This file merges the unresolved items that still block full parser confidence.

## Highest Priority

### Kiro

- Is the supported target Kiro IDE, Kiro CLI, or both?
- If SQLite under `~/.kiro/` is canonical for normal CLI chat, what exact DB filename/schema should `continues` read?
- Are the current parser’s `workspace-sessions/*.json` files still live anywhere outside exports/tests, or only an IDE-private/internal/export surface?

### Antigravity

- What schema governs the observed `.pb` conversation files under `~/.gemini/antigravity/conversations/`?
- Are `code_tracker` files auxiliary telemetry/code-edit state or some parser-useful secondary surface?
- What is the public first-party encryption/decryption contract, if any, for `.pb` conversation files?

### Gemini

- Which current installs still emit legacy JSON session objects?
- Should discovery detect JSON vs JSONL per session root or per file signature?
- Should the parser use `projects.json` / short-id mapping for workspace attribution, or is that too coupled to internal registry details?

### Kilo Code

- Is any current Kilo shipping surface still actively writing `ui_messages.json`, or should that now be treated as migration-only/legacy-only in this repo?
- Should `continues` explicitly support both extension-side legacy artifacts and the DB-backed/OpenCode-derived runtime, or only the canonical live store?

## Medium Priority

### Cursor

- How complete are local `agent-transcripts` relative to exported transcripts?
- Are tool inputs always present locally, or only on some builds/channels?
- Should the parser emit an explicit transcript-completeness warning by default for Cursor-derived handoffs?

### Factory Droid

- Did `~/.factory/projects/.../*.jsonl` fully replace `~/.factory/sessions/...`, or do both still coexist across versions/surfaces?
- What are the exact continuation semantics on disk: fresh file on resume, append to same file, or version-dependent behavior?

### Amp

- What is the exact on-disk schema/path of the client-side local thread history?
- Are local CLI thread artifacts a stable parser target, or is the web/server thread the only safe canonical surface?

### Copilot

- What role does per-session `session.db` play relative to `events.jsonl` and the global `session-store.db`?
- Should `continues` use it for richer tool/rewind/file context?
- Should Copilot discovery honor `COPILOT_HOME` / `--config-dir` fully and use `session-store.db` as a discovery/enrichment fallback when raw files are partial?

### Codex

- Which secondary artifacts should be exposed by default in the pointer block: rollout file only, or rollout plus state/history/index sidecars?
- Should the product explicitly warn that rollouts are primary but not guaranteed to capture every product surface perfectly, such as review-mode logging gaps?
- Does any current rollout sample still emit top-level token counters, or should nested `payload.info.*` be treated as the only supported shape?

### Handoff Contract

- What exact public API should represent the separate machine/inspection surface if the human-facing contract is simplified?
- Should same-tool debug become “show native resume/action path” instead of a hard error?
- Should prompt-debug output gain a structured machine-readable envelope in addition to plain text?
- Should artifact and MCP discovery become a shared parser-adjacent feature in `continues` rather than remain only in documentation?

## Recommended Next Validation Pass

Run live local captures for:

- `gemini`
- `kiro`
- `antigravity`
- `cursor`
- `amp`
- `droid`
- `kilo-code`

For each, capture the file tree after:

1. first prompt
2. first assistant response
3. first tool call
4. resume
5. compact/rewind if supported
6. archive/export if supported

Then compare the live tree to the corresponding docs in:

- `storage-format/`
- `message-schema/`
- `tool-call-map/`
- `access-recipes/`
- `handoff-pointers/`

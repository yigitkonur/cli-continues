# Kiro

Accessed: 2026-04-15

## Documented Fact

- Public Kiro IDE docs confirm that Kiro stores conversation history inside sessions and supports:
  - session switching
  - history viewing
  - restore
  - delete
  - markdown export
- Current first-party Kiro CLI docs describe:
  - a local SQLite session database under `~/.kiro/`
  - per-directory session scoping
  - UUID session IDs
  - autosave every conversation turn
  - list/delete/resume behavior
- No public env-var override was found for the Kiro CLI session database, and no public IDE storage override was found either.

## Inference

- Kiro’s current public storage model is clearly database-backed for the CLI.
- It is plausible that the IDE and CLI no longer share the old JSON layout assumed by `continues`, but I did not find first-party IDE storage-path documentation to prove that.

## Unresolved Uncertainty

- The `continues` parser targets:
  - `~/Library/Application Support/Kiro/workspace-sessions/`
  - JSON files with `sessionId`, `workspacePath`, and `history[]`
- I did not find first-party documentation for that path or schema.
- I could not verify whether the parser is describing:
  - a still-live private IDE store
  - a superseded IDE store
  - or an implementation that is now entirely obsolete

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/kiro.ts` describe a macOS app-support JSON store and label the source as “Kiro IDE”.
- Upstream public docs: current first-party storage guidance points to `~/.kiro/` SQLite for Kiro CLI, not app-support JSON.
- Risk: very high. The supported surface in `continues` may not match the current public Kiro product surface at all.

## Direct Access Recipe

- Publicly documented CLI path:
  - inspect `~/.kiro/` and its SQLite DB
- Parser-assumed legacy/IDE path:
  - `~/Library/Application Support/Kiro/workspace-sessions/`

## Sources

- Official IDE docs: https://kiro.dev/docs/chat/
- Official CLI docs: https://kiro.dev/docs/cli/chat/session-management/

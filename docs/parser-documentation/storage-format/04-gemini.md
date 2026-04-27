# Gemini CLI

Accessed: 2026-04-15

## Documented Fact

- Home-dir override: `GEMINI_CLI_HOME`
- Global root: `${GEMINI_CLI_HOME:-$HOME}/.gemini`
- Session/chat root:
  - `~/.gemini/tmp/<project-id>/chats/`
- Related stores:
  - `~/.gemini/projects.json`
  - `~/.gemini/history/<project-id>/`
  - `~/.gemini/settings.json`
- Current session file format: JSONL append log
- Filename behavior:
  - Main sessions: `session-<timestamp>-<session-id-prefix>.jsonl`
  - Subagents: `<session-id>.jsonl`
- Session-ID location:
  - Metadata records carry `sessionId`
  - The filename alone is not the full authoritative source for main sessions
- Record types observed in first-party code:
  - initial partial metadata record
  - message records with `id`
  - metadata updates via `$set`
  - rewind markers via `$rewindTo`
- Append/update behavior:
  - Gemini appends records with `appendFileSync`
  - Metadata changes are appended as `$set` records, not rewritten in place
  - Rewinds are appended as `$rewindTo` markers
  - Legacy `.json` sessions are loaded and migrated into `.jsonl`

## Observed Example

- The current `chatRecordingService.ts` explicitly migrates an older `.json` session into a new `.jsonl` file by appending initial metadata and then each message.

## Comparison Against `continues`

- Registry: `src/parsers/registry.ts` is only partially correct. `~/.gemini/tmp/*/chats/` and `GEMINI_CLI_HOME` still matter, but the registry omits the JSONL migration and append-log semantics.
- Parser: `src/parsers/gemini.ts` still treats the new format as `session-*.json` plus legacy `~/.gemini/sessions/*.json`.
- Risk: very high. The parser is now aimed at a superseded container format, so session discovery can silently miss the current transcript store.

## Direct Access Recipe

- Read raw chat log: `~/.gemini/tmp/<project-id>/chats/*.jsonl`
- Inspect project registry: `~/.gemini/projects.json`
- Inspect metadata updates: grep JSONL lines for `$set` or `$rewindTo`

## Sources

- Official repo code: https://github.com/google-gemini/gemini-cli


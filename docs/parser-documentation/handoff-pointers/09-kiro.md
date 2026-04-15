# Kiro

## Documented Facts

- Official Kiro docs say session data lives under `~/.kiro/`, uses SQLite, auto-saves every turn, and keys sessions by directory path.
- Official Kiro docs expose session-management commands like `kiro-cli chat --resume`, `--resume-picker`, `--list-sessions`, and `--delete-session <SESSION_ID>`.

## Observed Example

- `src/parsers/kiro.ts` still reads JSON files under `~/Library/Application Support/Kiro/workspace-sessions/...`.
- Local fixtures in `test-fixtures/kiro/workspace-sessions/` use a single JSON object with `sessionId`, `workspacePath`, `selectedModel`, and `history[]`.

## Inference

- Kiro is a high-risk mismatch. The pointer block for the redesign should reflect the official SQLite backend, not the legacy JSON fixture shape the current parser still uses.

## Unresolved Uncertainty

- The official docs do not publish the exact SQLite filename inside `~/.kiro/`.
- Current `continues` cannot yet populate DB path, row count, or SQL retrieval commands from real upstream storage.

## Default-Mode Pointer Block

- `Session`: Kiro / `<session-id>`
- `Backend`: `SQLite under ~/.kiro/`
- `Storage root`: `~/.kiro/`
- `Confidence`: `official-backend, current-parser-legacy`
- `Resume handle`: `kiro-cli chat --resume` or `kiro-cli chat --resume-picker`
- `Quick inspect`: `kiro-cli chat --list-sessions`

## Full-Mode Pointer Block

- Everything from default mode
- `Mismatch note`: `continues` is still reading legacy JSON exports/fixtures, not the official SQLite backend
- `State`: include working directory and UUID session ID when available from the current handoff context
- `Focused retrieval`:
  - `kiro-cli chat --list-sessions`
  - `kiro-cli chat --resume`
  - If future parser learns the DB filename, upgrade this section to SQL queries

## Why This Is Feasible

- The pointer block can honestly expose the official backend and current limitation even before the parser is rewritten.
- What is not feasible today is claiming a concrete SQLite file path or row count from `continues` itself.

## Current `continues` Comparison

- Current handoff logic is still built around a JSON session file layout that conflicts with the current official Kiro storage story.
- This tool should not share the same pointer contract as the stable JSONL tools until the parser is updated.

## Sources

- Official docs: https://kiro.dev/docs/cli/chat/session-management/ (accessed 2026-04-15)
- Local parser and fixtures: `src/parsers/kiro.ts`, `test-fixtures/kiro/workspace-sessions/test-workspace/test-session-1.json` (read 2026-04-15)

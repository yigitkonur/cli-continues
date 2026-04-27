# Kiro

## Raw storage

- Documented fact:
  - Official Kiro CLI docs say sessions are auto-saved on every turn in a local SQLite database under `~/.kiro/`.
  - Sessions are per-directory, keyed by directory path, and have UUID session IDs.
  - Kiro supports resume, interactive session picking, list, delete, save-to-file, and load-from-file commands.
- Observed example:
  - The parser’s expected path `~/Library/Application Support/Kiro/workspace-sessions/` does not exist on this machine.
- Inference:
  - The current `src/parsers/kiro.ts` is not aligned with current first-party Kiro CLI documentation.
- Unresolved uncertainty:
  - Whether Kiro IDE still maintains a separate JSON `workspace-sessions` store apart from Kiro CLI’s SQLite backend is not publicly documented in the sources inspected here.

## Tool-call encoding

- Documented fact:
  - No first-party public session-schema reference was found for raw tool-call storage inside Kiro’s SQLite backend.
- Observed example:
  - No local Kiro session store was available to inspect.
- Inference:
  - The current parser statement “Kiro sessions have no tool call data” should be treated as unverified.

## Write, edit, delete, search, MCP, shell

- Unresolved uncertainty:
  - No documented first-party evidence was found for exact persisted Kiro tool names or result placement.

## What `continues` abstracts away today

- `src/parsers/kiro.ts` only looks for JSON files with `sessionId`, `workspacePath`, `selectedModel`, and `history`.
- Official docs point instead to SQLite under `~/.kiro/`.
- This is likely a storage-backend mismatch, not just a missing field.

## Direct-access recipe

```bash
find ~/.kiro -name '*.db' 2>/dev/null

kiro-cli chat --list-sessions
```

## Sources

- Accessed 2026-04-15: https://kiro.dev/docs/cli/chat/session-management/

# Kilo Code Access Recipes

## Raw Source

- Documented fact: current first-party Kilo CLI docs support continuing sessions, exporting a session as JSON, importing session JSON, `/sessions`, `/copy`, and `/export`. Source: [Kilo CLI docs](https://kilo.ai/docs/code-with-ai/platforms/cli) (accessed 2026-04-15).
- Documented fact: first-party architecture docs say Kilo CLI has a Session Manager with persistent session state, conversation history, and checkpoints, and that the CLI lives in `packages/opencode/`. Source: [Kilo architecture](https://kilo.ai/docs/contributing/architecture) (accessed 2026-04-15).
- Current parser assumption: `kilo-code` uses a VS Code globalStorage task layout at `.../globalStorage/kilocode.kilo-code/tasks/`, mirroring Cline-family storage.
- Unresolved: I did not find first-party Kilo docs or code that confirm the parser’s VS Code task-folder layout for `kilo-code`, and the first-party CLI docs instead point toward CLI session persistence plus JSON export/import.

## Retrieval Patterns

### First-party CLI path: use export/import when you need raw JSON now

```bash
kilo --continue
kilo export <sessionID> > session.json
kilo import session.json
```

### Parser-targeted extension path: treat as provisional

```bash
base=~/Library/'Application Support'/Code/User/globalStorage/kilocode.kilo-code
find "$base/tasks" -maxdepth 2 -type f | head -n 30
```

### If the extension layout matches the Cline family

```bash
jq '.[9:30]' "$base/tasks/<task-id>/ui_messages.json"
jq '.[9:30]' "$base/tasks/<task-id>/api_conversation_history.json"
```

## Current Parser Comparison

- This tool should be treated as unresolved, not stable.
- The parser currently assumes a Cline-family extension layout, but first-party Kilo CLI docs emphasize CLI session persistence and JSON export/import instead.
- For redesign purposes, the pointer block should either detect which Kilo surface is present or explicitly say that the parser is using an unverified extension-storage model.

## Sources

- [Kilo CLI docs](https://kilo.ai/docs/code-with-ai/platforms/cli) (accessed 2026-04-15)
- [Kilo architecture](https://kilo.ai/docs/contributing/architecture) (accessed 2026-04-15)


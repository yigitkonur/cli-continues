# Kiro Access Recipes

## Raw Source

- Documented fact: current first-party Kiro CLI docs say sessions are auto-saved per directory in a SQLite database under `~/.kiro/`, and also support JSON save/load/export style flows such as `/chat save <path>` and `/chat load <path>`. Sources: [chat docs](https://kiro.dev/docs/cli/chat/), [session management docs](https://kiro.dev/docs/cli/chat/session-management/), [CLI commands](https://kiro.dev/docs/cli/reference/cli-commands/) (accessed 2026-04-15).
- Documented fact: Kiro docs explicitly say `/chat save` writes JSON files and `/chat load` reads JSON files; script hooks can receive or emit session JSON over stdin/stdout. Same sources, accessed 2026-04-15.
- Current parser assumption: `~/Library/Application Support/Kiro/workspace-sessions/<workspace>/*.json`. This is not supported by current first-party Kiro CLI docs.
- Observed example: this machine has `~/.kiro/` but no obvious session DB or exported chat files, and `~/Library/Application Support/Kiro/workspace-sessions/` does not exist. Observed 2026-04-15.
- Unresolved: the current parser may be targeting an older Kiro IDE/macOS layout or a different product surface than the current Kiro CLI docs.

## Retrieval Patterns

### Official CLI-level access

```bash
kiro-cli chat --list-sessions
kiro-cli chat --resume
/chat save backup.json
/chat load backup.json
```

### Probe the documented local storage root

```bash
find ~/.kiro -maxdepth 4 \( -name '*.db' -o -name '*.sqlite' -o -name '*.json' \)
```

### If the parser-targeted legacy JSON layout exists

```bash
find ~/Library/'Application Support'/Kiro/workspace-sessions -name '*.json' ! -name 'sessions.json'
jq '.history[9:30]' ~/Library/'Application Support'/Kiro/workspace-sessions/<workspace>/<session>.json
```

## Current Parser Comparison

- This is one of the clearest mismatches in the audit.
- Current parser targets a macOS JSON layout that current first-party CLI docs do not describe.
- The redesign should not present Kiro storage as settled. The pointer block should either detect the actual local layout at runtime or state that the parser is using a legacy/alternate storage strategy.

## Sources

- [Kiro chat docs](https://kiro.dev/docs/cli/chat/) (accessed 2026-04-15)
- [Kiro session management docs](https://kiro.dev/docs/cli/chat/session-management/) (accessed 2026-04-15)
- [Kiro CLI commands](https://kiro.dev/docs/cli/reference/cli-commands/) (accessed 2026-04-15)
- [Kiro slash commands](https://kiro.dev/docs/cli/reference/slash-commands/) (accessed 2026-04-15)


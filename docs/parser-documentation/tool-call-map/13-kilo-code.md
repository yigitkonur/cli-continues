# Kilo Code

## Raw storage

- Documented fact:
  - First-party Kilo issue #3706 refers to task storage under `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks`, with `ui_messages.json` and `ui_messages.json.lock`.
  - The current official Kilo repo also contains substantial `kilocode_change` modifications on top of an OpenCode-style session backend, including `packages/opencode/src/session/index.ts` and `packages/opencode/src/session/message-v2.ts`.
- Observed example:
  - No local Kilo task or session store was available on this machine.
- Inference:
  - First-party evidence conflicts. Kilo appears to have both legacy VS Code task snapshots and a newer OpenCode-derived session backend in play.
- Unresolved uncertainty:
  - Which backend is canonical for current Kilo releases was not resolved from public sources alone.

## Tool-call encoding

- Documented fact:
  - The Kilo issue describes `ui_messages.json` as an actively written task-history file that can lock and grow large.
  - The current official repo also defines an OpenCode-style `ToolPart` backend, where exact tool names live in `part.data.tool` and exact inputs/outputs live in `part.data.state`.
- Inference:
  - There are two plausible Kilo storage generations:
    - legacy extension snapshots in `ui_messages.json`
    - newer OpenCode-like SQLite/message-part storage with exact tool parts
- Unresolved uncertainty:
  - No first-party page was found that explicitly says whether both stores coexist or whether one superseded the other.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - The OpenCode-derived Kilo code path preserves exact tool names and structured tool state.
  - The issue-based `ui_messages.json` evidence only proves a UI snapshot file, not exact low-level tool semantics.
- Inference:
  - `continues` is safest if it treats Kilo as unresolved rather than assuming it is just another Cline-family `ui_messages.json` tool.

## What `continues` abstracts away today

- `src/parsers/cline.ts` currently handles `kilo-code` exactly like `cline` and `roo-code`.
- If the modern Kilo backend is OpenCode-derived, that parser is pointed at the wrong storage model and will miss exact tool parts entirely.
- If the legacy `ui_messages.json` backend is still active for some builds, exact tool names may still be unavailable there anyway.

## Direct-access recipe

```bash
find ~/.config/Code/User/globalStorage/kilocode.kilo-code -maxdepth 3 -type f 2>/dev/null

sqlite3 ~/.local/share/kilo*/**/*.db '.tables' 2>/dev/null
```

## Sources

- Accessed 2026-04-15: https://github.com/Kilo-Org/kilocode/issues/3706
- Accessed 2026-04-15: https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/session/index.ts
- Accessed 2026-04-15: https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/session/message-v2.ts

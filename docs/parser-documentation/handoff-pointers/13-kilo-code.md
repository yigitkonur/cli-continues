# Kilo Code

## Documented Facts

- First-party Kilo issue threads confirm an extension-style task store under `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks`, with `ui_messages.json` lock contention causing freezes.
- The same issue shows `.lock` artifacts and repeated failures to save `ui_messages.json`.

## Observed Example

- `src/parsers/cline.ts` parses Kilo Code with the same `ui_messages.json` schema used for Cline/Roo.
- `test-fixtures/kilo-code/tasks/test-task-1/ui_messages.json` matches that event-array format.
- A separate first-party repo search also surfaced a newer `kilo.db` / opencode-derived codebase, which suggests platform/storage convergence or product split beyond what this parser currently handles.

## Inference

- The current handoff pointer for Kilo Code should stay focused on the extension task store the parser actually reads, while explicitly warning that Kilo’s broader product family may also have newer non-extension storage backends.

## Unresolved Uncertainty

- It is not yet clear whether the VS Code extension task store and the newer first-party `kilo.db` codebase are parallel products, a migration path, or two fronts of the same product line.

## Default-Mode Pointer Block

- `Session`: Kilo Code / `<task-id>`
- `Task dir`: `<globalStorage>/kilocode.kilo-code/tasks/<task-id>/`
- `Primary file`: `ui_messages.json`
- `Backend`: JSON array event log
- `Volume`: `<array-length>` events
- `Quick inspect`: `jq '.[-12:]' <task-dir>/ui_messages.json`
- `Health note`: include `ui_messages.json.lock` state when present

## Full-Mode Pointer Block

- Everything from default mode
- `Companions`: enumerate sibling task files and any lock files
- `Variant note`: `continues` is using the extension task store, not the newer DB-backed Kilo codebase surfaced in first-party repo search
- `Focused retrieval`:
  - `find <task-dir> -maxdepth 1 -type f | sort`
  - `jq 'map(.say) | group_by(.) | map({say: .[0], count: length})' <task-dir>/ui_messages.json`

## Why This Is Feasible

- The parser already resolves the extension task directory and reads `ui_messages.json`.
- Sibling-file and lock checks are cheap and deterministic.

## Current `continues` Comparison

- Current handoff output hides the fact that Kilo Code is the most ambiguous member of the Cline-family tools in this audit: the parser reads extension task JSON, while first-party code search also exposed a newer DB-backed product surface.

## Sources

- First-party issue: https://github.com/Kilo-Org/kilocode/issues/3706 (accessed 2026-04-15)
- First-party repo code search: `Kilo-Org/kilocode` files `packages/opencode/src/session/index.ts` and `packages/opencode/src/storage/db.ts` (read 2026-04-15)
- Local parser and fixture: `src/parsers/cline.ts`, `test-fixtures/kilo-code/tasks/test-task-1/ui_messages.json` (read 2026-04-15)

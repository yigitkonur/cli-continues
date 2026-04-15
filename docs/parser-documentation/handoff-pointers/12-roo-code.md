# Roo Code

## Documented Facts

- First-party Roo Code issue threads confirm task data lives under the extension’s globalStorage path and that `ui_messages.json` is a critical per-task file.
- One issue explicitly references `$HOME/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks/<task-id>` and lock files associated with `ui_messages.json`.

## Observed Example

- `src/parsers/cline.ts` intentionally treats Roo Code as a Cline-family format using the same `ui_messages.json` event array.
- `test-fixtures/roo-code/tasks/test-task-1/ui_messages.json` matches the same raw schema pattern used for Cline and Kilo Code fixtures.

## Inference

- Roo Code should share the same pointer shape as Cline, but with an extension-specific base path and a lock-file warning because first-party issues show `ui_messages.json` lock contention is operationally relevant.

## Unresolved Uncertainty

- First-party Roo docs were lower-yield than issue threads for raw storage details in this pass, so the strongest explicit path evidence came from issue discussions rather than formal docs.

## Default-Mode Pointer Block

- `Session`: Roo Code / `<task-id>`
- `Task dir`: `<globalStorage>/rooveterinaryinc.roo-cline/tasks/<task-id>/`
- `Primary file`: `ui_messages.json`
- `Backend`: JSON array event log
- `Volume`: `<array-length>` events
- `Quick inspect`: `jq '.[-12:]' <task-dir>/ui_messages.json`
- `Health note`: mention `*.lock` files if present

## Full-Mode Pointer Block

- Everything from default mode
- `Companions`: `api_conversation_history.json`, `task_metadata.json`
- `Lock state`: call out `ui_messages.json.lock` or related lock files when present
- `Focused retrieval`:
  - `find <task-dir> -maxdepth 1 -type f | sort`
  - `jq 'map(.say) | group_by(.) | map({say: .[0], count: length})' <task-dir>/ui_messages.json`

## Why This Is Feasible

- `continues` already knows the task directory because `ui_messages.json` is the parsed source.
- Companion files and locks are cheap sibling-file checks.

## Current `continues` Comparison

- Current handoff output reflects the shared Cline-family message parsing but does not reveal Roo-specific operational context such as `ui_messages.json` lock failures.

## Sources

- First-party issue: https://github.com/RooCodeInc/Roo-Code/issues/6022 (accessed 2026-04-15)
- Local parser and fixture: `src/parsers/cline.ts`, `test-fixtures/roo-code/tasks/test-task-1/ui_messages.json` (read 2026-04-15)

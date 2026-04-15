# Roo Code Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: Roo Code stores task UI history in `ui_messages.json` and reads/writes it through `readTaskMessages(...)` and `saveTaskMessages(...)`.
- Documented fact: The task file lives in the extension’s globalStorage task directory.
- Documented fact: First-party issue reports show that Roo task directories can also contain `*.lock` files and can temporarily lack `ui_messages.json` after crashes.

## Assistant Messages

- Inference: Roo inherits the same `ClineMessage` model used by Cline-family extensions, so assistant turns are semantic `say` messages rather than explicit `role: "assistant"` records.
- Documented fact: Roo task code still refers to these as “Cline messages.”
- Inference: Assistant streaming chunks, final completions, and reasoning are represented the same way as in Cline’s `ui_messages.json`.

## User Messages

- Inference: User turns are likewise encoded via `ClineMessage` entries rather than a normalized user-role JSON object.
- This is consistent with Roo’s direct reuse of `readTaskMessages(...)`/`saveTaskMessages(...)` and the parser sharing implemented in `src/parsers/cline.ts`.

## Ordering, Boundaries, And Failure Modes

- Documented fact: `ui_messages.json` is a JSON array updated over time.
- Documented fact: Crash scenarios can leave lock files behind or leave a task directory with lock files but no `ui_messages.json`.
- Inference: Session discovery cannot assume every valid task directory has a readable message file.

## Direct Access

- Local task dir examples from first-party issue reporting:
- `~/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks/<task-id>/ui_messages.json`
- same directory may contain `*.lock`

## Parser Comparison

- `src/parsers/cline.ts` is the correct code path for Roo Code because Roo persists the same `ui_messages.json` task stream.
- The current parser will silently miss crash-recovery edge cases where a Roo task directory exists but `ui_messages.json` does not, exactly the failure mode described in Roo issue #6022.
- Tool-call coverage is limited for the same reason as Cline: `ui_messages.json` is a UI stream, not the full tool history.

## Sources

- Roo task persistence code: https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task-persistence/taskMessages.ts (accessed 2026-04-15)
- Roo task logic: https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task/Task.ts (accessed 2026-04-15)
- Roo storage failure issue: https://github.com/RooCodeInc/Roo-Code/issues/6022 (accessed 2026-04-15)

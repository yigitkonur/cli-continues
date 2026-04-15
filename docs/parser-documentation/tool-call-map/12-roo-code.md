# Roo Code

## Raw storage

- Documented fact:
  - Roo Code persists task snapshots in `ui_messages.json`.
  - Roo issue traffic explicitly references `ui_messages.json` and `api_conversation_history.json` as exported task-history artifacts.
  - Roo’s own packages define a Cline-style persisted message schema and save `ui_messages.json` via `taskMessages.ts`.
- Observed example:
  - No local Roo Code task folders were available on this machine.
- Inference:
  - Roo remains in the Cline-style UI snapshot family, but with explicit evidence that large `read_file` payloads can be stored inside `ui_messages.json`.

## Tool-call encoding

- Documented fact:
  - Roo’s `clineMessageSchema` preserves fields like `ts`, `type`, `ask`, `say`, `text`, `images`, `partial`, `reasoning`, `conversationHistoryIndex`, and context-management metadata.
  - Roo issue #8690 states that full `read_file` payloads were persisted into `ui_messages.json` snapshots.
  - Roo issue #9580 confirms `ui_messages.json` and `api_conversation_history.json` are user-visible task-history artifacts.
- Inference:
  - Roo may preserve more file-read detail than plain Cline, but still not a normalized exact tool transcript.
- Unresolved uncertainty:
  - No local sample was available to verify how exact tool names are surfaced in current Roo `ui_messages.json`.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - Roo persisted complete `read_file` contents in some `ui_messages.json` snapshots, which is strong evidence of file-read leakage into the UI layer.
- Inference:
  - That means Roo snapshots can contain tool-adjacent detail, but not necessarily a stable exact `name + args + result` record for every tool.

## What `continues` abstracts away today

- `src/parsers/cline.ts` handles `roo-code` exactly like `cline` and emits no tool summaries.
- That avoids fabricating exact tool names, but it also ignores persisted read-file payloads, `say`/`ask` tool markers, and other UI-layer operation hints that Roo actually stores.

## Direct-access recipe

```bash
find ~/Library/'Application Support'/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks -name ui_messages.json 2>/dev/null

jq '.[0] | keys' ~/Library/'Application Support'/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/<task-id>/ui_messages.json
```

## Sources

- Accessed 2026-04-15: https://github.com/RooCodeInc/Roo-Code/blob/main/packages/types/src/message.ts
- Accessed 2026-04-15: https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/task-persistence/taskMessages.ts
- Accessed 2026-04-15: https://github.com/RooCodeInc/Roo-Code/issues/8690
- Accessed 2026-04-15: https://github.com/RooCodeInc/Roo-Code/issues/9580

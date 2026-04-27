# GitHub Copilot CLI

## Raw storage

- Documented fact:
  - GitHub documents that every Copilot CLI session is recorded locally under `~/.copilot/session-state/`.
  - GitHub also documents a separate `~/.copilot/session-store.db` session store used by `/chronicle`.
  - Session data is written into a session-specific subdirectory and includes raw JSONL files.
- Observed example:
  - Local session directories contain combinations of `workspace.yaml`, `events.jsonl`, `vscode.metadata.json`, and `session.db`.
  - Some local session directories had `session.db` but no `events.jsonl`.
- Inference:
  - `events.jsonl` is only part of the Copilot storage story.
- Unresolved uncertainty:
  - GitHub docs do not publish the full on-disk schema for tool results or modified-file payloads inside session-state.

## Tool-call encoding

- Observed example:
  - Tool invocations appear in `events.jsonl` inside `assistant.message.data.toolRequests[]`.
  - Each tool request preserves exact upstream keys: `toolCallId`, `name`, `arguments`, and `type`.
  - Sample exact names observed locally: `report_intent` and `task`.
- Documented fact:
  - GitHub says session data contains prompts, Copilot responses, tools that were used, and details of files that were modified.
- Inference:
  - `events.jsonl` alone does not prove where Copilot stores tool results; richer detail may live elsewhere in the session directory or session store.
- Unresolved uncertainty:
  - No public first-party schema reference was found for `session.db` or the precise shape of file-modification records.

## Write, edit, delete, search, MCP, shell

- Observed example:
  - Exact tool names are preserved verbatim in `toolRequests[].name`.
  - Arguments live in `toolRequests[].arguments`.
- Inference:
  - Whether a request is read/write/edit/search/shell is not explicit in the event type; `continues` infers category by name matching.

## What `continues` abstracts away today

- `src/parsers/copilot.ts` only reads `workspace.yaml` plus `events.jsonl`.
- The parser currently states that “Copilot doesn't provide tool results,” but GitHub’s own docs say session-state stores a complete record and a separate session store exists.
- It ignores session directories that only have `session.db`.
- It also collapses exact request names into generic buckets through `classifyToolName()`.

## Direct-access recipe

```bash
find ~/.copilot/session-state -maxdepth 2 -type f | head -n 20

jq -c '{type,toolRequests:[.data.toolRequests[]?|{toolCallId,name,argKeys:(.arguments|keys? // []),type}]}' \
  ~/.copilot/session-state/<session-id>/events.jsonl | head
```

## Sources

- Accessed 2026-04-15: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- Accessed 2026-04-15: https://docs.github.com/en/copilot/how-tos/copilot-cli/chronicle
- Observed locally on 2026-04-15: `~/.copilot/session-state/...`

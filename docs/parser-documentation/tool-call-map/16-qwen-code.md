# Qwen Code

## Raw storage

- Documented fact:
  - The current official Qwen Code repo writes chat records as JSONL under `~/.qwen/tmp/<project-id>/chats/`.
  - Each persisted `ChatRecord` has `uuid`, `parentUuid`, `sessionId`, `timestamp`, `type`, `cwd`, and `version`, plus optional `message`, `usageMetadata`, `model`, `contextWindowSize`, `toolCallResult`, and `systemPayload`.
- Observed example:
  - No local `~/.qwen` session store existed on this machine.
- Inference:
  - The storage location documented in the current official repo conflicts with `src/parsers/qwen-code.ts`, which looks under `~/.qwen/projects/*/chats/`.
- Unresolved uncertainty:
  - No local sample was available to confirm whether released builds already use the repo-documented `~/.qwen/tmp/` location.

## Tool-call encoding

- Documented fact:
  - Assistant records store raw API `Content`, whose `parts[]` can include `functionCall`.
  - Tool results are stored either as `functionResponse` parts or as separate top-level `tool_result` records carrying `toolCallResult`.
  - `toolCallResult` is UI-oriented metadata and can include rich `resultDisplay` information.
  - Official export code reconstructs tool calls by matching function call IDs to function responses and `toolCallResult.callId`.
- Inference:
  - Qwen Code explicitly distinguishes model-visible content (`message.parts`) from UI recovery metadata (`toolCallResult`), and both matter for fidelity.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - Exact tool names are preserved in `functionCall.name`.
  - Arguments live in `functionCall.args`.
  - Result bodies live in `functionResponse.response.output`.
  - Rich file-operation metadata lives in `toolCallResult.resultDisplay`.
- Inference:
  - `continues` should keep both the raw function-call layer and the UI result-display layer for Qwen, not collapse them into a single summary string.

## What `continues` abstracts away today

- `src/parsers/qwen-code.ts` already understands a useful subset of the Qwen record model, but it is likely pointed at the wrong base directory.
- It also normalizes exact tool names into generic read/write/edit/search/fetch/shell buckets and only partially exposes `toolCallResult`.
- If the upstream path mismatch is real, none of that logic will run on current sessions anyway.

## Direct-access recipe

```bash
find ~/.qwen/tmp -path '*/chats/*.jsonl' 2>/dev/null | head

jq -c 'select(.type=="assistant" or .type=="tool_result") | {type,uuid,parentUuid,hasMessage:(.message!=null),hasToolCallResult:(.toolCallResult!=null)}' \
  ~/.qwen/tmp/<project-id>/chats/<session>.jsonl | head
```

## Sources

- Accessed 2026-04-15: https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts
- Accessed 2026-04-15: https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/ui/utils/export/collect.ts

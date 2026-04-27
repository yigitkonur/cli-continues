# Qwen Code Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: The official `QwenLM/qwen-code` code writes JSONL chat files under `~/.qwen/tmp/<project_id>/chats/`.
- Documented fact: Each JSONL line is a tree-structured `ChatRecord` with `uuid`, `parentUuid`, `sessionId`, `timestamp`, `type`, `cwd`, `version`, and optional `gitBranch`.
- Documented fact: Current record types are `user`, `assistant`, `tool_result`, and `system`.
- Documented fact: `system` records can represent `chat_compression`, slash-command replay, UI telemetry, and `@`-command replay.

## Assistant Messages

- Documented fact: Assistant turns are `type: "assistant"`.
- Documented fact: Assistant records carry `message` in raw API `Content` form, plus optional `model`, `usageMetadata`, `contextWindowSize`, and `toolCallResult`.
- Documented fact: Assistant content can therefore contain text, function-call parts, function-response-related context, and thought parts via the raw model content object.

## User Messages

- Documented fact: User turns are `type: "user"` and store `message: createUserContent(...)`.
- Documented fact: Tool results are not folded into assistant messages; they are separate `type: "tool_result"` records whose `message` is also stored as user-shaped content for model replay.

## Ordering, Boundaries, And Compaction

- Documented fact: Qwen stores a tree, not a plain linear log. Effective history is reconstructed by following `parentUuid`.
- Documented fact: Chat compression is explicit through `system` records with subtype `chat_compression` and payload `compressedHistory`.
- Documented fact: Session loading aggregates records along the parent chain and merges message/tool metadata as needed.
- Inference: Any parser that only scans file order without reconstructing the main branch risks wrong recent-message tails after rewinds/checkpoints/branching.

## Direct Access

- Chat files: `find ~/.qwen/tmp -path '*/chats/*.jsonl'`
- Inspect one record: `jq -c . ~/.qwen/tmp/<project>/chats/<session>.jsonl | head`

## Parser Comparison

- `src/parsers/qwen-code.ts` gets one major thing right: it reconstructs a main path via `parentUuid`.
- It appears to be using an outdated storage-path assumption, though. The parser looks under `~/.qwen/projects/*/chats/`, while the current official code documents `~/.qwen/tmp/<project_id>/chats/`.
- The parser also simplifies the official record model. Current upstream storage includes `system` records and richer `toolCallResult`/metadata fields that the parser does not fully preserve.
- This is a high-severity session-discovery risk even if the message-shape logic is directionally close.

## Sources

- Qwen chat recording service: https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts (accessed 2026-04-15)
- Qwen session service: https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/sessionService.ts (accessed 2026-04-15)

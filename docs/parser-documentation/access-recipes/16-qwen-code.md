# Qwen Code Access Recipes

## Raw Source

- Documented fact: first-party Qwen issue discussion references current history under `~/.qwen/history/<project_hash>/` and temp working state under `~/.qwen/tmp/<project_hash>/`, and proposes project-local chat export. Source: [Qwen issue #2373](https://github.com/QwenLM/qwen-code/issues/2373) (accessed 2026-04-15).
- Documented fact: current upstream repo code writes append-only JSONL chat records under `~/.qwen/tmp/<project_id>/chats/`, with record fields like `uuid`, `parentUuid`, `sessionId`, `type`, `message`, `usageMetadata`, `toolCallResult`, and `systemPayload`. Source: [QwenLM/qwen-code `chatRecordingService.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts) (accessed 2026-04-15).
- Current parser assumption: `.qwen/projects/<sanitized-cwd>/chats/*.jsonl` with part-based `functionCall` and `functionResponse` fields.
- Observed example: this machine has `~/.qwen/` config and skills, but no local chat JSONL files to verify the active path. Observed 2026-04-15.
- Inference: Qwen storage, like Gemini, appears to have changed over time; current parser path likely needs re-verification.

## Retrieval Patterns

### Probe the currently documented temp/history roots

```bash
find ~/.qwen/tmp -path '*/chats/*.jsonl' 2>/dev/null
find ~/.qwen/history -maxdepth 3 2>/dev/null
```

### If JSONL chats exist, slice rows 10-30

```bash
awk 'NR>=10 && NR<=30' ~/.qwen/tmp/<project>/chats/<session>.jsonl | jq .
```

### Extract tool-result or system records

```bash
jq -cr 'select(.type=="tool_result" or .type=="system")' ~/.qwen/tmp/<project>/chats/<session>.jsonl
```

### First-party export path

```bash
qwen chat export --session <session_id> --output ./qwen/chat-history/
```

## Current Parser Comparison

- Current parser targets `.qwen/projects/*/chats/*.jsonl`, but upstream code and issue discussion point to `~/.qwen/tmp/<project>/chats/` and `~/.qwen/history/`.
- This is likely a parser-staleness problem rather than a missing pointer problem.
- For redesign purposes, Qwen should expose the detected path at runtime instead of a fixed hardcoded convention.

## Sources

- [Qwen issue #2373](https://github.com/QwenLM/qwen-code/issues/2373) (accessed 2026-04-15)
- [QwenLM/qwen-code `chatRecordingService.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts) (accessed 2026-04-15)


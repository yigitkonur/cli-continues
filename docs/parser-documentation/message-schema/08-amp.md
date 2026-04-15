# Amp Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: Amp’s plugin API defines `ThreadID = \`T-\${string}\`` and a `ThreadMessage` union of `ThreadUserMessage`, `ThreadAssistantMessage`, and `ThreadInfoMessage`.
- Documented fact: User thread messages contain `(text | tool_result)[]` content blocks; assistant thread messages contain `(text | thinking | tool_use)[]` content blocks.
- Observed example: Local thread files were stored as JSON under `~/.local/share/amp/threads/T-....json`.
- Observed example: A sampled thread JSON had top-level keys including `id`, `created`, `messages`, `env`, `meta`, `agentMode`, and `nextMessageId`.

## Assistant Messages

- Documented fact: Assistant messages use `role: "assistant"` with block types `text`, `thinking`, and `tool_use`.
- Unresolved uncertainty: I did not find a local thread sample with both user and assistant messages populated, so the assistant block mix is documented from Amp’s plugin API rather than from a local on-disk example.

## User Messages

- Documented fact: User messages use `role: "user"` with block types `text` and `tool_result`.
- Observed example: A sampled local message object exposed fields like `role`, `messageId`, `content`, `userState`, `agentMode`, and `meta`.

## Ordering, Boundaries, And Timestamps

- Documented fact: Each message has a thread-unique numeric ID in the plugin API.
- Observed example: Local thread JSON clearly stores an ordered `messages[]` array.
- Observed example: Sampled local thread JSON did not show per-message timestamps; the parser’s use of the thread-level `created` timestamp as fallback is therefore understandable but lossy.
- Unresolved uncertainty: No explicit compaction or summary record was found in the plugin API or the local thread samples reviewed here.

## Direct Access

- List threads: `find ~/.local/share/amp/threads -name 'T-*.json'`
- Inspect a thread: `jq . ~/.local/share/amp/threads/T-....json`

## Parser Comparison

- `src/parsers/amp.ts` is directionally right about thread JSON storage.
- The parser is too narrow about content blocks: it only extracts `type: "text"` and ignores official `thinking`, `tool_use`, and `tool_result` block types documented by Amp itself.
- That means assistant-message reconstruction is incomplete today, especially for agent/tool-heavy turns.

## Sources

- Amp plugin API: https://ampcode.com/manual/plugin-api (accessed 2026-04-15)
- Observed local thread file: `~/.local/share/amp/threads/T-019cc922-3fd6-706b-9950-e56ccf39e65a.json` (accessed 2026-04-15)

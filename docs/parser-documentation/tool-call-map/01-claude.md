# Claude Code

## Raw storage

- Documented fact:
  - Anthropic documents `tool_use` and `tool_result` as content-block types in the Messages API. For client-side tools, Claude emits `tool_use` and the client sends back `tool_result`.
  - A first-party Claude Code issue confirms session JSONL files under `~/.claude/projects/` and shows that oversized `*.jsonl` session files can block startup.
- Observed example:
  - Local sessions live under paths like `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`.
  - Assistant records are top-level JSON objects with `type: "assistant"` and nested `message.content[]` blocks.
- Inference:
  - Claude Code session files are Anthropic-style JSONL plus Claude Code-specific top-level metadata.
- Unresolved uncertainty:
  - Anthropic does not publish a first-party Claude Code session-file schema reference for every top-level key added by the CLI.

## Tool-call encoding

- Documented fact:
  - `tool_use` blocks live inside assistant `message.content[]`.
  - `tool_result` blocks are returned in user messages.
- Observed example:
  - A local `Read` call appears as an assistant block: `{ "type": "tool_use", "id": "...", "name": "Read", "input": { "file_path": "..." }, "caller": { "type": "direct" } }`.
  - The matching result appears in a user message block: `{ "type": "tool_result", "tool_use_id": "..." }`.
  - Claude Code also adds a top-level `toolUseResult` object on the user event. For reads, observed keys were `type` and `file`. For edits, observed keys were `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`, `replaceAll`, and `userModified`.
- Inference:
  - `toolUseResult` is the real Claude Code CLI value-add for exact edit/read fidelity; it is richer than the plain `tool_result.content` string.
- Unresolved uncertainty:
  - A dedicated delete tool name was not found in the inspected local samples.

## Write, edit, delete, search, MCP, shell

- Observed example:
  - Shell calls use exact names like `Bash`.
  - File reads use `Read`.
  - File edits preserve structured patch data in `toolUseResult.structuredPatch`.
- Inference:
  - Delete behavior may be encoded as a particular edit/patch tool invocation rather than a separate universal `Delete` tool.

## What `continues` abstracts away today

- `src/parsers/claude.ts` delegates tool extraction to `extractAnthropicToolData()`.
- `src/utils/tool-extraction.ts` reads the `tool_use` block name and the plain `tool_result.content`, but it ignores Claude Code’s top-level `toolUseResult`.
- `src/types/tool-names.ts` collapses exact names like `Bash`, `Read`, `Edit`, `TodoWrite`, and MCP names into broad categories for summaries.
- Result: current handoffs lose exact structured diffs, caller metadata, read-file metadata, and some file-level edit semantics that Claude Code actually records.

## Direct-access recipe

```bash
rg -n '"tool_use"|"tool_result"' ~/.claude/projects -g '*.jsonl' | head

sed -n '10p;11p;16p' ~/.claude/projects/<project>/<session>.jsonl \
  | jq -c '{topType:.type,msgRole:.message.role,content:[(.message.content[]? | {type,name,id,tool_use_id,inputKeys:(.input|keys? // [])})],toolUseResultKeys:(.toolUseResult|keys? // [])}'
```

## Sources

- Accessed 2026-04-15: https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview
- Accessed 2026-04-15: https://github.com/anthropics/claude-code/issues/22365
- Observed locally on 2026-04-15: `~/.claude/projects/.../*.jsonl`

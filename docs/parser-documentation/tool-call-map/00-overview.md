# Tool Call Map Overview

This folder documents how each canonical tool actually records tool activity, and where `continues` currently loses fidelity.

## Highest-risk fidelity losses

- `gemini`: current upstream code writes JSONL session logs with metadata updates, rewinds, `toolCalls`, `thoughts`, and token snapshots, but `src/parsers/gemini.ts` only handles legacy `.json` conversation objects. This is a version-skew risk, not just a formatting difference.
- `qwen-code`: current upstream code says chat logs live under `~/.qwen/tmp/<project>/chats/`, while `src/parsers/qwen-code.ts` looks under `~/.qwen/projects/*/chats/`. If the repo code reflects released behavior, `continues` will miss sessions entirely.
- `kiro`: official Kiro CLI docs say sessions are auto-saved in SQLite under `~/.kiro/`, but `src/parsers/kiro.ts` only looks for JSON files under `~/Library/Application Support/Kiro/workspace-sessions/`. This looks like a backend mismatch.
- `cursor`: first-party Cursor staff state JSONL transcripts include tool inputs but intentionally omit tool outputs. `src/parsers/cursor.ts` currently reuses the Anthropic `tool_use`/`tool_result` extractor, which can overstate what raw Cursor transcripts really preserve.
- `opencode`: raw OpenCode storage is much richer than the current parser output. The local SQLite database stores exact tool names, inputs, outputs, statuses, attachments, and per-part timing, while `src/parsers/opencode.ts` reduces this to a session-level edit summary.
- `crush`: upstream schema stores structured `tool_call` and `tool_result` parts, but `src/parsers/crush.ts` only extracts plain text from `messages.parts`, losing exact tool names, arguments, result metadata, and error state.
- `kilo-code`: first-party evidence conflicts. Kilo issue traffic still references `ui_messages.json` under VS Code globalStorage, but the current official repo also ships `kilocode_change` modifications on top of an OpenCode-style session backend. `src/parsers/cline.ts` assumes only the older `ui_messages.json` family.
- `antigravity`: discovery now uses `.pb` conversations, brain artifacts, state summaries, and optional live RPC. Tool-call fidelity is still live-RPC-dependent because offline `.pb` transcript/tool schema is not public.

## Cross-cutting redesign implications

- Preserve exact upstream tool names. `src/types/tool-names.ts` and `src/utils/tool-summarizer.ts` currently collapse many names into generic buckets like shell/read/write/edit/search/fetch/task/mcp. That is useful for summaries, but it is not a faithful schema map.
- Preserve argument/result placement separately. Several tools do not put arguments and results in the same place:
  - Claude/Droid: assistant `tool_use`, user `tool_result`, with Claude Code also adding a top-level `toolUseResult`.
  - Codex: `function_call` or `custom_tool_call`, then later `function_call_output` or `custom_tool_call_output`, joined by `call_id`.
  - Qwen Code: assistant `functionCall` parts, plus `functionResponse` parts or separate `tool_result` records with `toolCallResult`.
  - OpenCode: `tool` parts embed both exact tool name and structured state.
- Stop assuming every tool preserves write/edit/delete equally. Some tools have rich diff objects (`claude`, `gemini`, `qwen-code`, `opencode`); some intentionally omit outputs (`cursor`); some only keep UI snapshots (`cline`, `roo-code`, at least part of `kilo-code` evidence).
- Introduce a top-of-handoff technical pointer block. The current `src/utils/markdown.ts` shows source/session path/cwd, but schema-sensitive tools need quick raw-access hints like:
  - exact file or DB path
  - record type names
  - where arguments live
  - where results live
  - whether outputs are omitted by design
  - the one-liner to inspect raw tool records
- Separate “raw fidelity” from “summary readability.” `SummaryCollector` is fine for a compact handoff, but the redesign should keep a raw tool-call appendix or machine-readable pointer so exact upstream names and result carriers are never lost.

## Most important parser-specific consequences

- `src/parsers/claude.ts`, `src/parsers/droid.ts`, and `src/parsers/cursor.ts` all rely on `extractAnthropicToolData()`. That helper ignores Claude Code’s extra `toolUseResult` metadata and assumes `tool_result` blocks are always present when outputs matter.
- `src/parsers/codex.ts` handles the common `function_call` and `custom_tool_call` paths, but it does not currently map newer persisted response types like `local_shell_call`, `tool_search_call`, or `tool_search_output`.
- `src/parsers/copilot.ts` only inspects `events.jsonl`, even though GitHub documents both per-session files and a separate `~/.copilot/session-store.db`.
- `src/parsers/opencode.ts` and `src/parsers/crush.ts` both under-read SQLite-backed stores.
- `src/parsers/cline.ts` assumes `cline`, `roo-code`, and `kilo-code` all share the same `ui_messages.json` storage story. That is safe only if Kilo has not fully moved to the newer OpenCode-style backend.

## Source handling standard used here

- `Documented fact`: official docs, official repositories, or first-party issue/forum statements.
- `Observed example`: local raw session data inspected on this machine on 2026-04-15.
- `Inference`: a conclusion drawn by comparing documented/observed evidence.
- `Unresolved uncertainty`: a gap that still needs direct upstream confirmation.

## Access date

- All external sources in this folder were accessed on 2026-04-15.

## Sources

- Accessed 2026-04-15: https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview
- Accessed 2026-04-15: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- Accessed 2026-04-15: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- Accessed 2026-04-15: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts
- Accessed 2026-04-15: https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts
- Accessed 2026-04-15: https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311
- Accessed 2026-04-15: https://kiro.dev/docs/cli/chat/session-management/
- Accessed 2026-04-15: https://github.com/charmbracelet/crush/blob/main/internal/message/content.go
- Accessed 2026-04-15: https://github.com/MoonshotAI/kimi-cli/blob/main/packages/kosong/src/kosong/message.py
- Accessed 2026-04-15: https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts

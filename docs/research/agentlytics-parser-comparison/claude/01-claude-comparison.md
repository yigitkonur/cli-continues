# Claude Parser Comparison: `continues` vs `agentlytics`

**Scope:** Claude Code only. Compares `continues` Claude parser/docs against agentlytics' Claude adapter and cache behavior, then checks both against Anthropic first-party docs/issues and current local Claude storage observations.
**Last updated:** 2026-04-15
**Confidence:** High — 10+ independent sources across Anthropic docs/issues, agentlytics first-party repo code, and local Claude storage

## 1. Summary

`continues` is materially stronger than agentlytics on Claude-specific session reconstruction. In [`src/parsers/claude.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/claude.ts), it understands Claude-only sidecars (`subagents/`, `tool-results/`), queue/task events, compacted-history cues, and token/cache accounting from assistant `usage`. Agentlytics' Claude path in `editors/claude.js`, `mod.ts`, and `cache.js` is narrower: it is optimized for chat/session analytics, not faithful session handoff or Claude-specific recovery.

Agentlytics is still stronger in two places. First, it preserves raw assistant messages with inline `[thinking]` and `[tool-call: ...]` markers in a way that is useful for analytics and later SQL queries. Second, it scans Claude project artifacts (`CLAUDE.md`, `.claude/settings*.json`, `.mcp.json`, `.claude/commands`) out of the box, while our Claude parser/docs discuss those files but the parser output itself is centered on transcript reconstruction rather than artifact indexing.

The largest confirmed miss on our side is that we still ignore Claude Code's top-level `toolUseResult` payload even though our docs correctly call it out. The largest confirmed miss on agentlytics' side is that it still treats `sessions-index.json` as a normal metadata source even though Anthropic docs no longer document it and current local Claude storage on this machine does not contain it at all.

## 2. Agentlytics parser surface

### Storage and discovery

- `editors/claude.js` hardcodes `~/.claude/projects` via `os.homedir()` and does **not** honor `CLAUDE_CONFIG_DIR`.
- It scans each project folder for `.jsonl` files and also tries to load `sessions-index.json` from each project directory.
- `mod.ts` duplicates the same Claude scan logic for the Deno CLI path, including the `sessions-index.json` assumption.
- Folder decoding uses `projDir.replace(/-/g, "/")`, which is heuristic and can produce an invalid path if the slugging scheme changes.

### Message reconstruction

- `getMessages()` in `editors/claude.js` only emits `user`, `assistant`, and `system` messages.
- User tool-result carrier turns are collapsed into normal `role: 'user'` messages via `extractContent()`, which only keeps `text` blocks. When a Claude user turn contains only `tool_result`, agentlytics drops it.
- Assistant turns are flattened into a single text blob by `extractAssistantContent()`.
- `thinking` blocks become `[thinking] ...`.
- `tool_use` blocks become `[tool-call: Name(arg1, arg2)]`, and the raw args are also kept in `_toolCalls`.
- `tool_result` inside assistant content is handled, but current Claude local observations show the normal pattern is assistant `tool_use` followed by user `tool_result`, so this branch is rarely the critical one.

### Tokens, model, and cache fields

- `editors/claude.js` attaches `_model`, `_inputTokens`, `_outputTokens`, `_cacheRead`, and `_cacheWrite` from `obj.message.usage`.
- `cache.js` persists those fields into SQLite and aggregates them for per-chat and per-model analytics.
- `cache.js` also falls back to character-based token estimation when token fields are absent.

### Artifact scanning

- `editors/claude.js#getArtifacts()` scans:
  - `CLAUDE.md`
  - `.claude/settings.json`
  - `.claude/settings.local.json`
  - `.mcp.json`
  - `.claude/commands/*`
- It does not scan `rules/`, `skills/`, `agents/`, `agent-memory/`, or Claude sidecar session folders.

### Summarization / verbosity implications

- Agentlytics stores assistant text largely verbatim, with inline markers for thinking and tool calls.
- `cache.js` truncates very long stored message content at 50,000 chars.
- Tool-result detail is lossy by design: assistant-side `tool_result` text is capped to 500 chars in the flattened message string, and user-side Claude `tool_result` is usually lost entirely.

## 3. Our parser surface

### Storage and discovery

- [`src/parsers/claude.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/claude.ts) discovers Claude sessions under `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`.
- It only accepts UUID-named `.jsonl` files and ignores debug files.
- It does **not** depend on `sessions-index.json`.
- The storage docs in [`docs/parser-documentation/storage-format/01-claude.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/01-claude.md) align with Anthropic's current `.claude` directory docs on transcripts, `tool-results/`, `file-history/`, and persistence-disable switches.

### Message reconstruction

- `extractClaudeContext()` reads the full JSONL transcript and filters to conversational `user`/`assistant` records.
- When `separateHumanFromToolResults` is enabled, pure tool-result user carrier turns are excluded from recent conversation. This matches Anthropic's documented tool-use pattern better than agentlytics' generic user-message handling.
- We also detect `isCompactSummary`, capture the latest compact summary, and optionally chain prior sessions when compaction cues suggest history was collapsed.
- Queue/task parsing is Claude-aware:
  - `queue-operation` events
  - tagged `<task-notification>` payloads
  - `TaskOutput` tool-result payloads
  - subagent transcript sidecars in `<session>/subagents/agent-<taskId>.jsonl`

### Tool-call capture

- Claude tool extraction is delegated to [`src/utils/tool-extraction.ts`](/Users/yigitkonur/dev/cli-continues/src/utils/tool-extraction.ts).
- That helper understands Anthropic-style `tool_use` + `tool_result` pairing and derives structured summaries for shell, read, write, edit, grep, glob, search, fetch, MCP, and task tools.
- It is better than agentlytics at deriving file modifications and concise handoff summaries.
- It is still incomplete for Claude Code because it ignores the top-level `toolUseResult` object Anthropic records on user tool-result lines.

### Tokens, model, and cache fields

- `extractSessionNotes()` aggregates model and token usage from assistant `message.usage`.
- It sums `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
- That aligns with current local Claude transcripts and Anthropic's prompt-caching concepts, even though Anthropic's public Claude Code docs do not publish a full transcript schema reference.

### Sidecars and artifacts

- `continues` is materially stronger on session sidecars:
  - `subagents/`
  - `tool-results/`
  - compact summaries
  - predecessor session chaining
- The docs are also stronger on operator guidance:
  - [`docs/parser-documentation/access-recipes/01-claude.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/01-claude.md)
  - [`docs/parser-documentation/handoff-pointers/01-claude.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/01-claude.md)
- Unlike agentlytics, our Claude parser does not separately index repo instruction artifacts like `CLAUDE.md` or `.claude/commands`; that knowledge currently lives in docs, not parser output.

### Summarization / verbosity implications

- `continues` is intentionally summarizing, not archival:
  - recent messages are truncated by preset
  - tool summaries are category-aware and sampled
  - reasoning highlights are extracted rather than preserved verbatim
  - subagent outputs are sampled and truncated
- This is better for handoff readability.
- It is worse than agentlytics if the goal is raw analytics over nearly verbatim assistant traces.

## 4. Where agentlytics is stronger

### 4.1 Artifact indexing is more explicit

Agentlytics' Claude adapter explicitly scans `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, and `.claude/commands/*` in `editors/claude.js`. Our Claude parser/docs know those files matter, but the parser output is transcript-centric. For workspace-level Claude configuration inventory, agentlytics currently exposes more directly.

### 4.2 Raw assistant flattening is better for analytics

`extractAssistantContent()` in `editors/claude.js` preserves assistant thinking and tool calls as inline markers in the assistant message stream. That is crude but queryable. Our parser converts Claude activity into summarized handoff sections, which is better for continuation but weaker for later SQL-style "show me all sessions where Claude thought X and then called Bash Y" analysis.

### 4.3 SQLite analytics path is broader

`cache.js` persists Claude messages, models, token counts, tool names, and derived costs into a queryable cache. `continues` does not offer an equivalent cross-session analytics store for Claude.

## 5. Where our parser/docs are stronger

### 5.1 Claude storage assumptions are more current

Our code and docs treat the JSONL transcript as canonical and avoid relying on `sessions-index.json`. That matches Anthropic's current `.claude` directory docs, which explicitly document `projects/<project>/<session>.jsonl`, `tool-results/`, and `file-history/`, but do not mention `sessions-index.json`.

### 5.2 Claude session reconstruction is meaningfully deeper

`continues` handles:

- compact summaries and history chaining
- user tool-result carrier filtering
- queue operations
- tagged task notifications
- `TaskOutput` reconciliation
- subagent transcript harvesting
- sidecar `tool-results/` previews

Agentlytics handles none of those Claude-only recovery paths.

### 5.3 Our docs identify a real Claude fidelity gap that agentlytics also misses

[`docs/parser-documentation/tool-call-map/01-claude.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/01-claude.md) correctly states that Claude Code adds a top-level `toolUseResult` object with richer structured data than plain `tool_result.content`. Agentlytics ignores that distinction entirely. Our code also still ignores it, but our documentation is at least correctly pointed at the real problem.

### 5.4 Our operator guidance is much stronger

The storage, schema, access-recipe, and handoff-pointer docs give a Claude-specific operational model that agentlytics does not provide:

- storage layout
- compact-summary cues
- sidecar inspection commands
- persistence caveats
- session pointer guidance

That is a real advantage for maintenance and future parser fixes.

## 6. Confirmed mismatches

### 6.1 Agentlytics assumes `sessions-index.json` is normal metadata; that is not supported by current Anthropic docs

- Agentlytics reads `projects/<project>/sessions-index.json` in both `editors/claude.js` and `mod.ts`.
- Anthropic's current `.claude` directory docs enumerate application-data paths and do not include `sessions-index.json`.
- On this machine, `find ~/.claude/projects -maxdepth 2 -name 'sessions-index.json'` returned no matches on 2026-04-15.
- First-party Anthropic issue `#25032` shows `sessions-index.json` can be stale enough to break `claude --resume`, which makes it a risky primary metadata source even if it exists in some versions.

**Conclusion:** agentlytics' index support is defensible as backward-compatibility, but not as a current Claude storage assumption.

### 6.2 Agentlytics does not honor `CLAUDE_CONFIG_DIR`

- `continues` uses `CLAUDE_CONFIG_DIR` in [`src/parsers/claude.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/claude.ts).
- Anthropic docs explicitly state that every `~/.claude` path moves under `CLAUDE_CONFIG_DIR` if set.
- Agentlytics hardcodes `~/.claude`.

**Conclusion:** this is a confirmed correctness gap in agentlytics for non-default Claude installations.

### 6.3 Agentlytics loses the normal Claude `tool_result` half of the turn

- Anthropic tool-use docs describe the pattern as assistant `tool_use` followed by client-supplied `tool_result`.
- Current local Claude transcripts on this machine show `tool_result` blocks on `type: "user"` lines, not assistant lines.
- Agentlytics' `extractContent()` only preserves `text` blocks in user messages, so a user turn that contains only `tool_result` becomes empty and is dropped.

**Conclusion:** agentlytics captures the tool call name and args, but usually not the actual Claude tool result body unless it can infer it elsewhere.

### 6.4 Our code still ignores Claude's top-level `toolUseResult`

- Current local Claude transcripts include `toolUseResult` with structured data such as `stdout`, `stderr`, `filenames`, `durationMs`, `structuredPatch`, and related metadata.
- [`src/utils/tool-extraction.ts`](/Users/yigitkonur/dev/cli-continues/src/utils/tool-extraction.ts) only reads `tool_result.content`.
- Our own Claude tool-call doc explicitly says this is a gap.

**Conclusion:** our docs are right, our implementation is not yet aligned.

### 6.5 Our storage-format doc understates current implementation strength on `tool-results/`

- [`docs/parser-documentation/storage-format/01-claude.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/01-claude.md) says `continues` does not model `tool-results/`.
- Current code in [`src/parsers/claude.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/claude.ts) does parse `tool-results/` previews into `sessionNotes.externalToolResults`.

**Conclusion:** the doc is partially stale relative to the current parser.

### 6.6 Agentlytics has no Claude-side compaction or subagent awareness

- Anthropic hooks docs explicitly expose `PreCompact` and `PostCompact`, including `compact_summary` and `transcript_path`.
- Anthropic subagent docs describe concurrent/background subagents, and current local Claude storage contains `<session>/subagents/*.jsonl`.
- `continues` has explicit compaction and subagent handling in [`src/parsers/claude.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/claude.ts).
- Agentlytics does not inspect sidecar subagent folders or compact-summary markers.

**Conclusion:** agentlytics' Claude view is shallow for resumed or delegated sessions.

## 7. Still unresolved

- Anthropic publicly documents the `.claude` directory layout, compaction hooks, and subagent concepts, but it still does not publish a full line-by-line Claude transcript schema. Some conclusions therefore still rely on local observation.
- The exact spill threshold or routing rule for when Claude writes large outputs into `tool-results/` instead of keeping them inline is not documented.
- `sessions-index.json` appears in Anthropic issues but not current docs or current local storage here. It is unclear whether it is version-gated, platform-gated, or being phased out.
- Anthropic docs do not currently document the full shape of `toolUseResult`, even though current local transcripts clearly contain it.

See [99-open-issues.md](/Users/yigitkonur/dev/cli-continues/docs/research/agentlytics-parser-comparison/claude/99-open-issues.md) for the remaining unresolved questions.

## 8. URLs

### Anthropic first-party

- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/sub-agents
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- https://github.com/anthropics/claude-code/issues/25032
- https://github.com/anthropics/claude-code/issues/22365
- https://github.com/anthropics/claude-code/issues/3833

### Agentlytics first-party

- https://raw.githubusercontent.com/f/agentlytics/master/editors/claude.js
- https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
- https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
- https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- https://raw.githubusercontent.com/f/agentlytics/master/cache.js

### Local files compared

- /Users/yigitkonur/dev/cli-continues/src/parsers/claude.ts
- /Users/yigitkonur/dev/cli-continues/src/utils/tool-extraction.ts
- /Users/yigitkonur/dev/cli-continues/src/types/schemas.ts
- /Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/01-claude.md
- /Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/01-claude.md
- /Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/01-claude.md
- /Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/01-claude.md
- /Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/01-claude.md

### Local Claude storage observations used as evidence

- `~/.claude/projects/.../*.jsonl` samples observed on 2026-04-15
- `~/.claude/projects/.../<session>/subagents/*.jsonl` samples observed on 2026-04-15
- `~/.claude/projects/.../<session>/tool-results/*` samples observed on 2026-04-15

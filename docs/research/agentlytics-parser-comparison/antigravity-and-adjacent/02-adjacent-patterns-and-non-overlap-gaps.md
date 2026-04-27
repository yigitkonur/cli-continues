# Adjacent patterns from agentlytics and implications for non-overlap tools

**Scope:** Reusable parser, normalization, artifact, MCP, and summarization patterns from `f/agentlytics` shared/editor layers, with implications for `amp`, `droid`, `crush`, `kilo-code`, `qwen-code`, `cline`, and `roo-code` in this repo.
**Last updated:** 2026-04-15

## 1. Summary

The main reusable value in `agentlytics` is not its UI or cache DB. It is its willingness to normalize across heterogeneous storage backends by introducing editor-local reconstruction logic before aggregation. The strongest adjacent patterns are:

- reconstructing patch/event logs into durable session state
- supporting dual-format or dual-backend migrations instead of forcing one canonical store
- scanning workspace artifacts and MCP configs as first-class context
- recovering truncated conversation tails from secondary metadata
- accepting editor-specific tool/result blocks, then projecting them into a shallow common shape

This repo already has a better shared rendering stack than `agentlytics` in `/Users/yigitkonur/dev/cli-continues/src/utils/tool-summarizer.ts`, `/Users/yigitkonur/dev/cli-continues/src/utils/markdown.ts`, and `/Users/yigitkonur/dev/cli-continues/src/config/verbosity.ts`. The gap is not presentation. The gap is backend ambition. Several of our non-overlap tools still parse only the easiest visible transcript while leaving adjacent artifacts, config, or migrated storage formats on the floor.

## 2. Reusable agentlytics shared-layer patterns

### Pattern: reconstruction before normalization

- `f/agentlytics/editors/vscode.js` reconstructs Copilot session state from JSONL patches where `kind: 0` is init and `kind: 1` is path-based patch application.
- This is stronger than treating JSONL as one-message-per-line text, because it acknowledges that some tools persist state deltas rather than append-only chats.
- Reusable lesson:
  - when a source is patch/event based, build a tiny reconstructor first, then reuse the same downstream normalization flow.

### Pattern: multi-source session recovery

- `f/agentlytics/editors/goose.js` reads both SQLite sessions and legacy JSONL sessions.
- `f/agentlytics/editors/antigravity.js` merges live RPC chats with offline `state.vscdb` trajectory summaries.
- Reusable lesson:
  - a parser should support primary plus fallback backends where upstream tools are clearly migrating.
  - this is especially relevant when local docs or issues already show “old path still in the wild, new path in repo code”.

### Pattern: secondary metadata to repair incomplete message streams

- `f/agentlytics/editors/antigravity.js` and `f/agentlytics/editors/windsurf.js` use `generatorMetadata[].chatModel.messagePrompts` to recover tails missing from step lists.
- Reusable lesson:
  - if the obvious event stream is truncated, look for compacted context, prompt history, or step metadata before concluding that chronology is unavailable.

### Pattern: artifact scanning as parser-adjacent, not UI-only

- `f/agentlytics/editors/base.js` defines `scanArtifacts(folder, { files, dirs })`.
- `f/agentlytics/editors/index.js` aggregates editor-specific artifacts plus shared files like `AGENTS.md`, `.mcp.json`, `plan.md`, `progress.md`, `TODO.md`, `ARCHITECTURE.md`, and `PLANNING.md`.
- Reusable lesson:
  - artifacts should be treated as part of session context extraction, even if the core transcript format lacks explicit tool metadata.

### Pattern: MCP config normalization

- `f/agentlytics/editors/base.js` normalizes multiple MCP config shapes and can even query server tool lists.
- `f/agentlytics/editors/index.js` also scans project-level configs across several editors.
- Reusable lesson:
  - MCP visibility should be a shared capability, not reimplemented per parser.

### Pattern: editor-local structural flattening

- `f/agentlytics/editors/zed.js`, `commandcode.js`, and `goose.js` each understand their tool block structures, but they all emit a shallow common shape with `role`, `content`, optional `_toolCalls`, and optional `_model`.
- Reusable lesson:
  - preserve editor-specific richness as long as needed, then flatten late.

## 3. Implications for our non-overlap tools (`amp`, `droid`, `crush`, `kilo-code`, `qwen-code`, `cline`, `roo-code`)

### `amp`

- Current local state:
  - `/Users/yigitkonur/dev/cli-continues/src/parsers/amp.ts` extracts messages and some notes, but it leaves `toolSummaries` empty.
  - Our own docs already flag storage uncertainty around the local JSON thread store.
- Adjacent implication:
  - adopt the “primary plus secondary evidence” pattern.
  - If Amp has thread web pages and streamed JSON docs, parser design should keep a distinction between local thread JSON and richer runtime/event surfaces.

### `droid`

- Current local state:
  - `/Users/yigitkonur/dev/cli-continues/src/parsers/droid.ts` is relatively strong already and does extract tool data.
- Adjacent implication:
  - Droid is the best candidate for artifact and MCP-layer upgrades.
  - If Factory’s JSONL already includes compaction and todo state, add adjacent workspace artifact scanning rather than only message parsing.

### `crush`

- Current local state:
  - `/Users/yigitkonur/dev/cli-continues/src/parsers/crush.ts` emits no files modified, pending tasks, or tool summaries.
  - Our docs already note DB-first storage.
- Adjacent implication:
  - copy Goose’s “dual backend or migration-aware” mindset where applicable.
  - if Crush’s DB contains richer message-part or tool/result tables than the current extraction uses, the parser should expose them before investing more in markdown output polish.

### `kilo-code`

- Current local state:
  - Kilo is still handled in `/Users/yigitkonur/dev/cli-continues/src/parsers/cline.ts`.
  - Our docs already say official Kilo code has moved toward `kilo.db` plus OpenCode-like session/message/part storage.
- Adjacent implication:
  - this is the clearest place to copy `agentlytics/editors/goose.js`.
  - support both legacy `ui_messages.json` and newer DB-backed storage rather than forcing Kilo to remain permanently inside the Cline-family format.

### `qwen-code`

- Current local state:
  - `/Users/yigitkonur/dev/cli-continues/src/parsers/qwen-code.ts` already uses `SummaryCollector` and is one of the better shared-layer citizens.
- Adjacent implication:
  - Qwen Code is a good target for adjacent artifact/MCP scanning because the transcript layer is already decent.
  - The next gap is broader project context, not raw message parsing.

### `cline`

- Current local state:
  - `/Users/yigitkonur/dev/cli-continues/src/parsers/cline.ts` extracts reasoning and pending tasks from `ui_messages.json`, but explicitly leaves `toolSummaries` empty.
- Adjacent implication:
  - use `commandcode.js` and `zed.js` as examples of block-aware tool-call flattening.
  - If Cline-family `ui_messages.json` contains richer structured tool events in some versions, parse them into `SummaryCollector` instead of accepting “tool summaries unavailable” as a permanent limit.

### `roo-code`

- Current local state:
  - Roo Code rides the same Cline-family parser and inherits the same omissions.
- Adjacent implication:
  - separate “same current storage family” from “same long-term parser ownership”.
  - If Roo adds its own metadata or project artifact surface, give it an adapter boundary even if it still reuses Cline event parsing underneath.

## 4. Verbosity/summarization differences

`agentlytics` and this repo solve different problems.

- `agentlytics` favors extraction-first analytics.
  - It stores normalized messages, tool calls, token counts, and costs into a local cache DB in `cache.js`.
  - It uses adapter-local previews, line limits, and block flattening to feed analytics and dashboard queries.
- `continues` favors handoff-quality context.
  - `/Users/yigitkonur/dev/cli-continues/src/config/verbosity.ts` defines typed caps and presets.
  - `/Users/yigitkonur/dev/cli-continues/src/utils/tool-summarizer.ts` centralizes tool sample limits and formatting.
  - `/Users/yigitkonur/dev/cli-continues/src/utils/markdown.ts` centralizes markdown layout and category-aware rendering.

Practical difference:

- `agentlytics` is better at saying "what happened across many sessions and tools?"
- `continues` is better at saying "what is the right amount of context to hand one session to another agent?"

Recommended synthesis:

- keep our shared verbosity system
- borrow `agentlytics`’ deeper backend extraction
- do not copy its adapter-local truncation style into our parsers

## 5. Recommended adoptions or rejections

### Adopt

- Adopt reconstruction helpers for non-append-only formats.
  - Best precedent: `f/agentlytics/editors/vscode.js`
  - Likely targets: any parser facing JSONL patch logs or delta-based session state.
- Adopt migration-aware dual backend support.
  - Best precedent: `f/agentlytics/editors/goose.js`
  - Highest-value local targets: `kilo-code`, then possibly `crush`.
- Adopt a shared artifact scanner in `continues`.
  - Best precedent: `f/agentlytics/editors/base.js` plus `editors/index.js`
  - Local gap: we do not currently have a shared artifact-scanning layer for parser context.
- Adopt shared MCP config discovery as a library utility.
  - Best precedent: `f/agentlytics/editors/base.js`
  - Local gap: parser docs repeatedly surface MCP uncertainty, but parser code does not have a shared MCP normalization helper.
- Adopt secondary-metadata tail recovery where the primary event stream truncates.
  - Best precedent: `f/agentlytics/editors/antigravity.js` and `editors/windsurf.js`
  - Local target: any parser with compacted or summarized histories.

### Reject

- Reject copying `agentlytics`’ live-RPC process-scraping approach as a default shared pattern.
  - It is powerful, but it is editor-process dependent, fragile, and not a safe baseline for `continues`.
  - If we ever add it, it should be a confidence-graded optional backend, not the canonical parser contract.
- Reject copying adapter-local preview/truncation rules into our parser files.
  - We already have a better architecture for that in `/Users/yigitkonur/dev/cli-continues/src/config/verbosity.ts`, `/Users/yigitkonur/dev/cli-continues/src/utils/tool-summarizer.ts`, and `/Users/yigitkonur/dev/cli-continues/src/utils/markdown.ts`.
- Reject assuming all adjacent tools need one monolithic analytics cache.
  - `agentlytics/cache.js` makes sense for analytics queries. It is not obviously the right abstraction for `continues`, whose primary deliverable is per-session handoff context.

## 6. URLs

- Agentlytics shared base:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
- Agentlytics editor registry:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
- Agentlytics VS Code adapter:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/vscode.js
- Agentlytics Windsurf adapter:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/windsurf.js
- Agentlytics Zed adapter:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/zed.js
- Agentlytics Command Code adapter:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/commandcode.js
- Agentlytics Goose adapter:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/goose.js
- Agentlytics Deno sandboxed entrypoint:
  - https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- Agentlytics analytics cache:
  - https://raw.githubusercontent.com/f/agentlytics/master/cache.js

# Gemini parser comparison: `cli-continues` vs agentlytics

**Scope:** Gemini only. Compares the current local Gemini parser/docs in this repo against agentlytics' Gemini parser behavior, then checks both against first-party Gemini CLI code and docs.
**Last updated:** 2026-04-15
**Confidence:** High for parser-code comparisons and Gemini upstream storage behavior; Medium for exact release-cutover timing because first-party docs and code disagree on some path details.

## Summary

Both implementations are still primarily **legacy-Gemini JSON parsers**, not current **append-only JSONL** parsers.

- `cli-continues` local parser at `/Users/yigitkonur/dev/cli-continues/src/parsers/gemini.ts` scans `session-*.json` under `~/.gemini/tmp/*/chats/` plus legacy `~/.gemini/sessions/*.json`, parses a full `messages[]` object, and then builds a handoff-oriented summary.
- agentlytics full adapter at `https://raw.githubusercontent.com/f/agentlytics/master/editors/gemini.js` also scans `session-*.json` under `~/.gemini/tmp/*/chats/`, parses the same legacy object shape, and feeds messages into analytics storage.
- agentlytics' Deno "sandboxed edition" path in `https://raw.githubusercontent.com/f/agentlytics/master/mod.ts` is materially different again: it looks for `.jsonl` files directly under `~/.gemini/tmp/<project>/`, not under `chats/`, and expects line records with `role` and `parts`. That does **not** match current first-party Gemini chat-recording code, which writes JSONL under `.../chats/` and uses metadata/message/update/rewind records rather than simple `{ role, parts }` lines.

The biggest difference between the projects is that this repo's Gemini documentation is ahead of both code paths. The docs under:

- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/04-gemini.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/04-gemini.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/04-gemini.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/04-gemini.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/04-gemini.md`

already describe the upstream JSONL migration, `$set` metadata updates, and `$rewindTo` markers from the first-party `google-gemini/gemini-cli` code. agentlytics has no comparable Gemini-specific documentation in the inspected surface.

## Agentlytics parser surface

### 1. Full adapter: `editors/gemini.js`

`https://raw.githubusercontent.com/f/agentlytics/master/editors/gemini.js`

- Session discovery:
  - Reads `~/.gemini/projects.json`.
  - Scans `~/.gemini/tmp/<proj>/chats/session-*.json`.
  - Does **not** scan `.jsonl`.
  - Does **not** honor `GEMINI_CLI_HOME`.
- Project mapping:
  - Correctly reverses `projects.json` into `Map<shortId, folderPath>` and populates `folder`.
- Message reconstruction:
  - Converts `user` to `role: 'user'`.
  - Converts `gemini` to `role: 'assistant'`.
  - Preserves assistant text plus prepends `[thinking] ...` lines from `thoughts`.
  - Appends `[tool-call: <name>(<argKeys>)]` markers into assistant content.
  - Emits `info` / `error` / `warning` as `role: 'system'`.
- Tool capture:
  - Stores `_toolCalls` with exact `name` and raw `args`.
  - Stores `_model`, `_inputTokens`, `_outputTokens`, `_cacheRead`.
  - Does not preserve tool result payloads, `resultDisplay`, tool-call IDs, descriptions, status, or agent IDs.
- Rewind / metadata handling:
  - None. It expects a complete legacy JSON object with `record.messages`.

### 2. Registry/integration: `editors/index.js`, `cache.js`, `editors/base.js`

- `https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js`
  - Registers the Gemini adapter and routes `getMessages(chat)` to it.
- `https://raw.githubusercontent.com/f/agentlytics/master/cache.js`
  - Persists Gemini-derived assistant messages, token fields, and `_toolCalls` into SQLite analytics tables.
  - This gives agentlytics stronger cross-session analytics once parsing succeeds: tool frequency, dominant models, estimated cost, project rollups.
- `https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js`
  - Shared helpers only; no Gemini-specific storage logic beyond common artifact and MCP parsing.

### 3. Separate Deno surface: `mod.ts`

`https://raw.githubusercontent.com/f/agentlytics/master/mod.ts`

- Scans `~/.gemini/tmp/<proj>/*.jsonl`, not `~/.gemini/tmp/<proj>/chats/*.jsonl`.
- Expects each JSONL line to look like chat history with `role === "user" | "model"` and `parts[0].text`.
- Uses filename as `composerId`.
- This is inconsistent with first-party `chatRecordingService.ts`, which writes:
  - initial partial metadata record
  - message records with `id`, `type`, `content`
  - metadata updates via `$set`
  - rewind markers via `$rewindTo`
  - all under `.../chats/*.jsonl`

So agentlytics currently has **two** Gemini behaviors:

- the main Node adapter, which matches legacy `.json`
- the Deno edition, which attempts `.jsonl` but not the real Gemini recorder format

## Our parser surface

### 1. Parser: `/Users/yigitkonur/dev/cli-continues/src/parsers/gemini.ts`

- Session discovery:
  - Honors `GEMINI_CLI_HOME` via `process.env.GEMINI_CLI_HOME || homeDir()`.
  - Scans `~/.gemini/tmp/<project>/chats/session-*.json`.
  - Scans legacy `~/.gemini/sessions/*.json`.
  - Does **not** scan `.jsonl`.
- Schema assumptions:
  - `/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts` requires a single JSON object containing `sessionId`, `projectHash`, `startTime`, `lastUpdated`, and `messages[]`.
  - This matches legacy Gemini session blobs, not current JSONL append logs.
- Message reconstruction:
  - User messages: extracts text from `content`.
  - Assistant messages: only adds a recent message when `extractGeminiContent(msg.content)` is non-empty.
  - `info` / `error` / `warning` are ignored in recent conversation extraction.
  - Tool-call-only Gemini messages are therefore omitted from `recentMessages`.
- Tool capture:
  - Stronger than agentlytics for handoff fidelity.
  - Summarizes tool activity with `SummaryCollector`.
  - Uses `resultDisplay.fileDiff`, `diffStat`, `isNewFile`, shell output tails, fetch previews, exact tool names, and file-path inference.
  - Extracts `filesModified`.
- Session notes:
  - Aggregates model, input/output tokens, cached tokens, thinking tokens, and reasoning highlights from `thoughts`.
- Project/root recovery:
  - Leaves `cwd` empty even though Gemini maintains `~/.gemini/projects.json` and project temp directories are keyed by a project identifier.
  - This is weaker than agentlytics for workspace attribution.

### 2. Local docs

The local Gemini docs are materially broader and more accurate than the parser:

- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/04-gemini.md`
  - documents JSONL append-log behavior, `$set`, `$rewindTo`, and legacy migration
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/04-gemini.md`
  - documents `MessageRecord`, rewind semantics, and replay risks
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/04-gemini.md`
  - documents `ToolCallRecord` fields and richer `resultDisplay`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/04-gemini.md`
  - gives separate JSON and JSONL access patterns
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/04-gemini.md`
  - explicitly says pointer blocks need a storage-variant distinction

## Where agentlytics is stronger

### 1. Workspace/project attribution is better in the main adapter

`editors/gemini.js` loads `~/.gemini/projects.json` and maps Gemini short project IDs back to real folders. `src/parsers/gemini.ts` does not, so it emits `cwd: ''`. On legacy sessions, agentlytics gives better per-project analytics and grouping.

### 2. Assistant reconstruction is more inclusive for thought/tool-only turns

agentlytics turns a Gemini assistant record into one assistant message if it has any of:

- `thoughts`
- text content
- `toolCalls`

`src/parsers/gemini.ts` only emits assistant recent messages when `msg.content` yields text. That means tool-call-only Gemini turns disappear from the recent-conversation handoff, even though the raw session stored them.

### 3. Post-parse analytics are stronger

`cache.js` persists:

- tool calls into `tool_calls`
- token fields into `messages` and `chat_stats`
- model frequency and cost estimates across sessions

This is better than `cli-continues` if the goal is longitudinal analytics rather than cross-tool handoff context.

## Where our parser/docs are stronger

### 1. Our Gemini docs correctly identify the upstream JSONL recorder

The strongest difference in this comparison is not parser code. It is documentation quality. The local docs explicitly track the current first-party recorder semantics from:

- `packages/core/src/services/chatRecordingService.ts`
- `packages/core/src/services/chatRecordingTypes.ts`
- `packages/core/src/config/storage.ts`

and explain append-only JSONL, metadata replay, rewinds, and legacy migration. agentlytics' inspected Gemini files do not show this awareness.

### 2. Tool-call summarization is richer for handoff use

`src/parsers/gemini.ts` preserves more handoff-relevant structure from legacy tool calls than agentlytics does:

- diff stats
- file diffs
- new-file detection
- shell stdout tails
- fetch previews
- file modification lists
- normalized summary buckets for downstream handoff markdown

agentlytics keeps exact tool names and args, which is useful, but it drops most result-display richness.

### 3. We already model the upstream mismatch explicitly

The local docs do not pretend the current parser is current. They explicitly call out that `/Users/yigitkonur/dev/cli-continues/src/parsers/gemini.ts` is behind upstream Gemini storage. That makes this repo's Gemini knowledge base more trustworthy than agentlytics' implementation surface.

### 4. `GEMINI_CLI_HOME` support exists here

First-party Gemini code resolves home paths through `homedir()` in `packages/core/src/utils/paths.ts`, and `homedir()` checks `GEMINI_CLI_HOME` before `os.homedir()`. `src/parsers/gemini.ts` follows that. agentlytics' inspected Gemini code paths use `os.homedir()` / `HOME` directly and ignore that override.

## Confirmed mismatches

### 1. Current Gemini CLI storage is JSONL append-log, not legacy-only JSON

Confirmed from first-party Gemini code:

- `chatRecordingService.ts` loads JSONL by replaying lines, supports `$set` and `$rewindTo`, and falls back to legacy `.json`.
- new sessions are created as `.jsonl` under `.../chats/`.
- legacy `.json` sessions can be migrated into `.jsonl`.

Implication:

- `/Users/yigitkonur/dev/cli-continues/src/parsers/gemini.ts` is outdated because it only parses `.json`.
- `https://raw.githubusercontent.com/f/agentlytics/master/editors/gemini.js` is also outdated because it only parses `.json`.

### 2. agentlytics `mod.ts` JSONL handling does not match Gemini's real JSONL schema

First-party Gemini JSONL records are not plain `{ role, parts }` chat lines. They are a mixed append log of metadata, message records, metadata updates, and rewind markers. agentlytics `mod.ts` therefore does not match the current recorder even where it tries to support `.jsonl`.

### 3. Neither parser handles rewind semantics

First-party `loadConversationRecord()` replays `$rewindTo` and merges repeated message IDs when reconstructing conversation state. Neither:

- `/Users/yigitkonur/dev/cli-continues/src/parsers/gemini.ts`
- `https://raw.githubusercontent.com/f/agentlytics/master/editors/gemini.js`

implements equivalent logic. On current Gemini JSONL sessions, both can produce the wrong conversation tail unless rewritten to replay the log.

### 4. Both parsers drop or distort some upstream metadata

From first-party `ToolCallRecord` and `MessageRecord` types, Gemini can persist:

- tool call `id`
- `status`
- `timestamp`
- `agentId`
- `displayName`
- `description`
- `resultDisplay`
- `renderOutputAsMarkdown`
- token subfields including `tool` and `total`

Observed mismatches:

- agentlytics keeps `name`, `args`, model, and some token fields, but not rich display/result metadata.
- `cli-continues` keeps more result-display information in summaries, but still does not expose raw IDs, agent IDs, or rewind-aware tool evolution.

### 5. Session discovery differs, and both have blind spots

- agentlytics `editors/gemini.js`:
  - good: uses `projects.json`
  - bad: legacy `.json` only, no `GEMINI_CLI_HOME`
- agentlytics `mod.ts`:
  - bad: wrong directory and wrong JSONL record assumptions
- `cli-continues`:
  - good: supports `GEMINI_CLI_HOME`
  - bad: no `projects.json` recovery, no `.jsonl`

### 6. Verbosity/summarization tradeoff differs

- agentlytics is better for analytics breadth:
  - more permissive assistant-message reconstruction
  - stores message rows, model rows, tool-call rows, and cost estimates
- `cli-continues` is better for concise handoff:
  - strips recent conversation down to user/assistant text
  - summarizes tool activity into categories and file changes
  - highlights reasoning and pending tasks

But the current `cli-continues` Gemini parser has a concrete summarization bug: tool-only assistant turns are omitted from `recentMessages`, so the handoff can understate what Gemini actually did.

## Still unresolved

- First-party docs and first-party code do not fully agree on whether the `~/.gemini/tmp/<...>/` directory component should be described as a project hash, project ID, or human-readable short slug. Current code uses `ProjectRegistry.getShortId(...)` for directory naming, but some docs still say `<project_hash>`.
- The exact released Gemini CLI version where recorded chat storage switched from legacy `.json` blobs to current `.jsonl` append logs was not verified from a first-party changelog entry in this comparison.
- The inspected local docs say legacy `.json` files still exist in the wild, and first-party code supports migrating them, but the exact coexistence behavior across release channels remains partially implicit.

See `/Users/yigitkonur/dev/cli-continues/docs/research/agentlytics-parser-comparison/gemini/99-open-issues.md`.

## URLs

### Local repo files compared

- `/Users/yigitkonur/dev/cli-continues/src/parsers/gemini.ts`
- `/Users/yigitkonur/dev/cli-continues/src/types/schemas.ts`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/04-gemini.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/04-gemini.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/04-gemini.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/04-gemini.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/04-gemini.md`

### Agentlytics files compared

- https://raw.githubusercontent.com/f/agentlytics/master/editors/gemini.js
- https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
- https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
- https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- https://raw.githubusercontent.com/f/agentlytics/master/cache.js

### First-party Gemini evidence

- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingService.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingTypes.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/storage.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/projectRegistry.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/utils/paths.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/session-management.md
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/commands/resumeCommand.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/commands/chatCommand.ts

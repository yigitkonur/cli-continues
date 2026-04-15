# Cursor Parser Comparison: `cli-continues` vs `agentlytics`

## 1. Summary

This comparison is only about Cursor.

`cli-continues` currently centers Cursor support on local `agent-transcripts` JSONL files in [`/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts). Its documentation set under:

- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/07-cursor.md)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/07-cursor.md)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/07-cursor.md)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/07-cursor.md)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/07-cursor.md)

is materially more careful than the code about transcript incompleteness, export-vs-local ambiguity, and warning needs.

`agentlytics` splits Cursor into two different adapters:

- `editors/cursor.js`
- `editors/cursor-agent.js`

That split is important. `editors/cursor.js` is materially stronger than `cli-continues` when undocumented local Cursor stores exist, because it reads:

- `~/.cursor/chats/<workspace>/<chatId>/store.db`
- `Cursor/User/workspaceStorage/...`
- `Cursor/User/globalStorage/state.vscdb`

and can recover tool calls, some tool results, model hints, token counts, and richer assistant content. On this machine, `~/.cursor/chats/.../store.db` does exist and contains richer data than the transcript JSONL.

But `agentlytics` is also materially less conservative. It converts undocumented Cursor internals into analytics-friendly message streams without the warning layer that `cli-continues` already documents as necessary. Its `cursor-agent` adapter is especially lossy: it assumes transcript JSONL is basically text-only and does not attempt block-aware tool extraction at all.

Bottom line:

- For current warning quality and export/local caveat handling, `cli-continues` docs are stronger.
- For completeness on machines where `store.db` and/or Cursor DB state exist, `agentlytics` is stronger.
- For the current `cli-continues` implementation, there is a confirmed code/docs mismatch: the code still assumes Anthropic-style transcript completeness more strongly than the docs and first-party Cursor evidence justify.

## 2. Agentlytics parser surface

Relevant files:

- `https://github.com/f/agentlytics/blob/master/editors/cursor.js`
- `https://github.com/f/agentlytics/blob/master/editors/cursor-agent.js`
- `https://github.com/f/agentlytics/blob/master/editors/index.js`
- `https://github.com/f/agentlytics/blob/master/cache.js`
- `https://github.com/f/agentlytics/blob/master/mod.ts`
- `https://github.com/f/agentlytics/blob/master/editors/base.js`

Observed behavior:

- `editors/cursor.js` reads two undocumented Cursor storage families.
- Source 1 is `~/.cursor/chats/<workspace>/<chatId>/store.db`.
- Source 2 is VS Code-style Cursor app storage under `Cursor/User/workspaceStorage` plus `Cursor/User/globalStorage/state.vscdb`.
- `editors/cursor.js` reconstructs tree/blob-backed messages from `store.db`, parses OpenAI-style `tool_calls`, preserves `_toolCalls`, and attaches `_model` when present.
- `editors/cursor.js` also reads `toolFormerData`, `thinking`, `tokenCount`, and truncated `result` previews from composer bubbles in DB-backed state.
- `cache.js` persists those extracted `_toolCalls`, token counts, and model names into analytics tables and aggregates them into top-tool/top-model stats.
- `editors/cursor-agent.js` separately scans `~/.cursor/projects/*/agent-transcripts`, supports both flat and nested JSONL layout, strips wrappers like `<user_query>`, and turns transcript rows into plain `user`/`assistant` text messages.
- `editors/cursor-agent.js` does not extract tool blocks or tool results from transcript block types. It only handles `text` blocks and synthetic `[file: ...]` references from embedded tags.
- `mod.ts` still carries an older Cursor scanner that labels Cursor as “file-based chats only, no SQLite,” which is now narrower than `editors/cursor.js`.

Local confirmation on this machine:

- `~/.cursor/chats/.../store.db` exists.
- Example exact path: `~/.cursor/chats/0607b860e9c8a921340e6e5f8fa63415/ca38930e-96e0-413f-a36f-65a7f0322657/store.db`
- Its `meta.key='0'` payload decodes to JSON containing `agentId`, `latestRootBlobId`, `name`, `mode`, `createdAt`, `lastUsedModel`, and `currentPlanUri`.
- Blob rows in that same DB contain richer JSON than the paired transcript file, including assistant `reasoning` content and Cursor tool-call records such as `{"type":"tool-call","toolName":"Write",...}`.

Discussion:

- Case for agentlytics being right: Cursor clearly has richer local state than transcript JSONL alone. The local `store.db` proves that on this machine.
- Case against agentlytics overclaiming: none of those richer stores are publicly documented by Cursor Help docs, and the app-data database paths are missing on this machine even though Cursor still works. So `agentlytics` is reading real data, but from unstable, undocumented surfaces.

## 3. Our parser surface

Relevant files:

- [`/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/07-cursor.md)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/07-cursor.md)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/07-cursor.md)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/07-cursor.md)
- [`/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/07-cursor.md`](/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/07-cursor.md)

Observed behavior:

- The parser only scans `~/.cursor/projects/<slug>/agent-transcripts/...jsonl`.
- It infers `cwd` from the encoded project slug.
- It derives summary text from the first real user text block.
- It feeds every transcript row into shared Anthropic-style extraction via `extractAnthropicToolData(...)`.
- It also assumes `usage` and `model` passthrough fields may exist on assistant rows and aggregates them if found.
- For recent messages, it only keeps `text` blocks and drops everything else.
- It emits no explicit warning inside the parser output that Cursor transcript completeness may be partial.

Documented behavior in this repo is more cautious than the implementation:

- The docs explicitly say first-party Cursor evidence supports local `agent-transcripts` existence but not a full stable schema.
- The docs explicitly separate local `agent-transcripts` from exported/shared transcript behavior.
- The docs explicitly record first-party forum statements that JSONL transcript/export behavior may omit `tool_use` and is expected to omit `tool_result`.
- The docs explicitly recommend a handoff-level completeness warning before normalized tool summaries.

Local confirmation on this machine:

- `~/.cursor/projects/.../agent-transcripts/*.jsonl` exists.
- Example exact path: `~/.cursor/projects/Users-yigitkonur-dev-test-cli-continues/agent-transcripts/16f31a93-4d65-4b9d-bad9-bb082f4aa56e.jsonl`
- The sampled transcript rows on this machine are text-only at the block level.
- In the sampled JSONL, `.message.content[]` entries are all `{"type":"text",...}`.
- That means the parser’s current Anthropic-style tool extraction path is not evidenced by the local sample files read for this review.

Discussion:

- Case for our parser being right: Cursor staff did say on 2026-04-13 that JSONL transcript files include tool call inputs, so the shared Anthropic-style path could match some newer sessions.
- Case against our parser being right today: the current code assumes more than the local sample and more than Cursor’s export/tool-output caveats justify. The docs already admit this.

## 4. Where agentlytics is stronger

- It uses more than one local storage surface. `editors/cursor.js` reads `store.db`, workspace storage, and global DB state; [`/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts) only reads transcript JSONL.
- It can recover richer message structure when `store.db` exists. On this machine, `store.db` contains assistant reasoning and tool-call objects that are not present in the paired transcript file.
- It has a more realistic path for tool-input completeness, because `normalizeStoreMessage()` and `bubblesToMessages()` persist `_toolCalls` from internal Cursor objects rather than waiting for transcript JSONL to contain matching Anthropic blocks.
- It captures some tool-output signal. `bubblesToMessages()` appends a truncated `[tool-result: ...]` preview from `toolFormerData.result`, while `cli-continues` currently has no alternative source for tool outputs.
- It captures more verbosity-sensitive metadata: model hints, token counts, tool counts, file references, and thinking text.
- It recognizes both flat and nested transcript layouts in `editors/cursor-agent.js`; `cli-continues` effectively supports both because it scans depth 2 for `.jsonl`, but its docs and implementation language still frame the nested `<uuid>/<uuid>.jsonl` pattern as the primary one.

## 5. Where our parser/docs are stronger

- The documentation is substantially more honest about uncertainty. The Cursor docs set in this repo repeatedly labels observed facts, inference, and unresolved uncertainty instead of flattening them into one parser story.
- The docs explicitly compare local transcript behavior against exported/shared transcript behavior. `agentlytics` code does not make that distinction visible.
- The docs explicitly warn that tool fidelity may be incomplete and that transcript-only summaries can look more complete than the source warrants.
- The docs cite first-party Cursor forum posts about:
  - transcript files living under `.cursor/projects/.../agent-transcripts`
  - UI recovery depending on `state.vscdb` and `workspaceStorage`
  - JSONL omitting tool outputs
  - export still dropping command/file-edit content in March 2026
- The current `cli-continues` scope is narrower but easier to defend from first-party public evidence. `agentlytics` is stronger operationally, but its SQLite and KV assumptions are much more reverse-engineered.
- Warning implications are better handled here, at least in docs. This repo already identifies the need for a top-of-handoff completeness warning before normalized tool summaries. `agentlytics` converts hidden-store data into analytics without an equivalent trust banner.

## 6. Confirmed mismatches

### A. `cli-continues` code overstates Cursor transcript structure relative to its own docs

Confirmed mismatch:

- [`/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts) routes transcript rows through `extractAnthropicToolData(...)` and assumes `usage`/`model` passthroughs may meaningfully populate handoff output.
- But this repo’s own Cursor docs say local transcript samples were text-only and that first-party Cursor statements do not support transcript completeness for tool results.
- The first-party March 14 and March 25 forum threads say JSONL/export may still contain only text or omit agent command/file-edit data entirely.

Why this matters:

- Current handoff summaries can imply a normalized tool history that the raw transcript did not actually preserve.
- This is not just a data-loss problem; it is a trust problem. The parser may make Cursor look more transcript-complete than Cursor is.

### B. `agentlytics` has an internal split-brain Cursor model

Confirmed mismatch:

- `editors/cursor.js` treats Cursor as a multi-source hidden-state system with `store.db`, workspace DBs, and global DBs.
- `editors/cursor-agent.js` treats Cursor agent transcripts as a separate text-oriented source.
- `mod.ts` still describes Cursor as “file-based chats only, no SQLite.”

Why this matters:

- There is not one agentlytics Cursor story; there are at least three layers of it.
- Consumers can easily misread `agentlytics` as having a single stable Cursor adapter when its own codebase shows an evolving, partially overlapping model.

### C. `agentlytics cursor-agent` understates transcript richness whenever transcript blocks regain tool inputs

Confirmed mismatch:

- On 2026-04-13, Cursor staff said JSONL transcript files include tool call inputs but intentionally omit tool outputs.
- `editors/cursor-agent.js` only reads `text` blocks and never inspects non-text transcript content types.

Why this matters:

- If Cursor has already restored `tool_use`-like blocks in some builds, `cursor-agent.js` will miss them even when they are present.
- So agentlytics is simultaneously stronger than `cli-continues` on hidden stores and weaker than it could be on transcript blocks.

### D. Export behavior remains materially less complete than local hidden-state behavior

Confirmed mismatch:

- Cursor Help docs on shared transcripts describe what is shareable and explicitly note what is not shared.
- Cursor forum threads in January and March 2026 still report exported transcripts omitting command/file-edit/thinking content.
- `agentlytics` relies on local hidden stores for richer reconstruction; `cli-continues` relies on local transcript JSONL; neither implementation should treat exported transcript behavior as equivalent to local data completeness.

Why this matters:

- “Transcript completeness” is not one thing in Cursor. Local hidden stores, local `agent-transcripts`, exported transcripts, and shared transcripts do not have the same fidelity.

## 7. Still unresolved

- Whether current local `agent-transcripts` broadly include restored tool-input blocks in April 2026, or whether Cursor staff’s April 13 statement only reflects some builds or some transcript paths.
- Whether local `agent-transcripts` and exported transcript JSONL share the same serializer. First-party evidence currently suggests they do not behave the same, but Cursor has not published a schema or lifecycle document.
- Whether `~/.cursor/chats/.../store.db` is a durable modern Cursor source or an implementation detail that could disappear. It exists on this machine, but it is not documented by public Cursor docs.
- Whether the missing `Cursor/User/globalStorage/state.vscdb` and `workspaceStorage` paths on this machine mean agentlytics’ DB-backed source 2 is stale on macOS, optional, or simply absent for this install.
- Whether `cli-continues` should add a second Cursor ingestion path for `store.db`, or whether that would violate the project’s current “publicly supportable evidence first” posture.

See `99-open-issues.md` for the testable follow-ups.

## 8. URLs

- Cursor shared transcripts docs: https://cursor.com/help/ai-features/shared-transcripts
- Cursor hooks docs: https://cursor.com/docs/hooks
- Cursor forum, “Where are cursor chats stored?”: https://forum.cursor.com/t/where-are-cursor-chats-stored/77295
- Cursor forum, “Chat history not loading after VS Code Settings Sync, possible state inconsistency”: https://forum.cursor.com/t/chat-history-not-loading-after-vs-code-settings-sync-possible-state-inconsistency/150559
- Cursor forum, “Lost all cursor settings and chat history for all projects I am working on :-(”: https://forum.cursor.com/t/lost-all-cursor-settings-and-chat-history-for-all-projects-i-am-working-on/151081
- Cursor forum, “.jsonl format should fully record the tool_use information”: https://forum.cursor.com/t/jsonl-format-should-fully-record-the-tool-use-information/154777
- Cursor forum, “Accessing the Full Agent Transcript in Cursor”: https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311
- Cursor forum, “Transcripts no longer exported in full”: https://forum.cursor.com/t/transcripts-no-longer-exported-in-full/150214
- Cursor forum, “Exporting transcript doesn't export agent commands”: https://forum.cursor.com/t/exporting-transcript-doesnt-export-agent-commands/155837
- agentlytics `cursor.js`: https://raw.githubusercontent.com/f/agentlytics/master/editors/cursor.js
- agentlytics `cursor-agent.js`: https://raw.githubusercontent.com/f/agentlytics/master/editors/cursor-agent.js
- agentlytics `base.js`: https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
- agentlytics `index.js`: https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
- agentlytics `mod.ts`: https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- agentlytics `cache.js`: https://raw.githubusercontent.com/f/agentlytics/master/cache.js

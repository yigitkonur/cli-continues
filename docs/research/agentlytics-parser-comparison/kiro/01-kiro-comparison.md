# Kiro parser comparison: `continues` vs `agentlytics`

Last updated: 2026-04-15

## 1. Summary

The strongest first-party evidence says current public Kiro has two documented persistence surfaces:

- normal CLI chat is auto-saved in a SQLite-backed store under `~/.kiro/`
- ACP sessions are persisted under `~/.kiro/sessions/cli/` as `<session-id>.json` plus `<session-id>.jsonl`

That means both parsers miss the current public Kiro storage story if the goal is "parse what Kiro officially documents today". `continues` is explicit about that mismatch in its Kiro docs, while `agentlytics` is materially better at mining likely IDE-private artifacts under Kiro's VS Code-style extension storage.

The most defensible split is:

- `continues` docs are stronger on source quality and on calling out uncertainty
- `agentlytics` code is stronger on IDE/private-surface coverage and message recovery breadth
- neither implementation currently matches the documented CLI SQLite store or the documented ACP event-log store

## 2. Agentlytics parser surface

### 2.1 Full adapter: `editors/kiro.js`

`agentlytics` has a two-strategy Kiro adapter in `editors/kiro.js`.

| Surface | Behavior in `agentlytics` | Evidence status |
| --- | --- | --- |
| Root storage path | Uses `getAppDataPath('Kiro')/User/globalStorage/kiro.kiroagent` | Partly supported by first-party issue logs, not by official docs |
| Strategy 1 | Reads `workspace-sessions/<folder>/sessions.json` plus `<sessionId>.json` | `workspace-sessions` and `sessions.json` are unverified |
| Strategy 2 | Reads `.chat` files from hashed directories under `.../kiro.kiroagent/`, groups snapshots by `executionId`, keeps the snapshot with the highest message count | `.chat` file existence is supported by first-party issue logs; grouping logic is inferred from code |

Important details from `editors/kiro.js`:

- It assumes the workspace folder name inside `workspace-sessions/` is base64-encoded and decodes it to a real path.
- It trusts `sessions.json` metadata for `sessionId`, `title`, and `dateCreated`.
- It tries to recover workspace folders from `session.workspaceDirectory` or the decoded directory name.
- It treats `.chat` files as "individual agent executions" and deduplicates by `executionId`.
- It recovers titles from a rules-wrapped human message by taking text after `</user-rule>` and stripping `<EnvironmentContext>` and `<steering-reminder>`.
- It reconstructs folder paths for `.chat` files by regex-parsing `file://.../.kiro/...` from `context[].id`.

### 2.2 Message reconstruction in `editors/kiro.js`

For `workspace-session` files:

- `getWorkspaceSessionMessages()` reads `history[]`
- only `user` and `assistant` roles survive
- message content is flattened from `text` and `mention` blocks
- assistant model is read from `entry.promptLogs[0].modelTitle` when present

For `.chat` files:

- `human` becomes `user`
- `bot` becomes `assistant`
- `tool` becomes `tool`
- messages starting with `<identity>` or `# ` are treated as system prompts and dropped from user-visible reconstruction
- tool messages are truncated to 2000 characters

### 2.3 Full analytics path: `cache.js`

`cache.js` preserves all reconstructed messages, including `tool` role messages, but its structured tool-call extraction is weak for Kiro:

- it only records structured tool calls when a message has `msg._toolCalls`, or when assistant text contains a `[tool-call: ...]` marker
- the Kiro adapter in `editors/kiro.js` never populates `_toolCalls`
- so Kiro tool analytics mostly fall back to counting raw `tool` messages, not structured tool names/args

This matters because Kiro's official ACP docs describe `ToolCall` and `ToolCallUpdate` as first-class session updates with names and parameters. `agentlytics` does not currently parse Kiro's documented ACP event log.

### 2.4 Sandboxed edition: `mod.ts`

`mod.ts` is weaker than `editors/kiro.js` for Kiro. Its `scanKiro()` only looks at:

- `getAppDataPath("Kiro")/User/globalStorage/kiro.kiroagent`
- `workspace-sessions/<folder>/sessions.json`
- `<sessionId>.json`

It does not implement the `.chat` fallback from `editors/kiro.js`.

## 3. Our parser surface

### 3.1 Parser: `/Users/yigitkonur/dev/cli-continues/src/parsers/kiro.ts`

Our current parser is narrow and legacy-shaped:

- root path is `~/Library/Application Support/Kiro/workspace-sessions/`
- it scans one directory level down and ignores `sessions.json`
- it only accepts JSON files with `sessionId` and `history[]`
- it expects `history[].message.role` plus `history[].message.content`
- it extracts the first `user` message as the session summary
- it uses file `birthtime` and `mtime` as session timestamps
- it exposes `selectedModel` as `model`
- it emits no files-modified, no pending tasks, and no tool summaries

Its message handling is simple:

- `user` stays `user`
- every non-`user` role is collapsed to `assistant`
- content is flattened via `extractTextFromBlocks()`

That simplicity avoids some heuristic lossiness, but only if the input file really matches this shape.

### 3.2 Our Kiro docs

The Kiro docs under:

- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/09-kiro.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/09-kiro.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/09-kiro.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/09-kiro.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/09-kiro.md`

are materially more careful than the implementation:

- they say official Kiro CLI docs now point to `~/.kiro/` SQLite
- they say the current parser's `workspace-sessions` assumption is not supported by public Kiro docs
- they explicitly mark tool-call claims as unverified
- they recommend runtime detection or an explicit "legacy/alternate" warning for Kiro

So the implementation is stale, but the documentation already describes that staleness fairly accurately.

## 4. Where agentlytics is stronger

### 4.1 Better IDE/private-surface coverage

This is the biggest implementation advantage.

`agentlytics` is closer to Kiro's IDE/private surface because:

- it targets the VS Code-style extension root `.../User/globalStorage/kiro.kiroagent`
- it is cross-platform via `getAppDataPath()`
- it has a second `.chat` strategy when `workspace-sessions` metadata is absent
- it retains `tool` messages from `.chat` files
- it extracts assistant model info from `promptLogs` or `.chat` metadata

There is first-party support for parts of this:

- official Kiro issue logs show extension activation for `kiro.kiroAgent`
- official Kiro issue logs show storage rooted under `.../User/globalStorage/kiro.kiroagent/...`
- official Kiro issue logs show `[ChatFile] Wrote chat file ... .chat`

That does not prove all of `editors/kiro.js`, but it does make its root path and `.chat` fallback materially better supported than our current app-support path.

### 4.2 Better message recovery breadth

Compared with `/Users/yigitkonur/dev/cli-continues/src/parsers/kiro.ts`, `agentlytics` can recover:

- legacy workspace-session messages
- `.chat` execution messages
- tool-role messages
- some model metadata

Our parser only handles one JSON shape and throws away all tool fidelity.

### 4.3 Better Kiro-adjacent inventory

`editors/kiro.js` also scans:

- `AGENTS.md`
- `.kiro/specs`
- `.kiro/steering`
- `~/.kiro/settings/mcp.json`

That is broader Kiro ecosystem support than anything in the current `continues` parser.

## 5. Where our parser/docs are stronger

### 5.1 Stronger grounding in official Kiro docs

Our docs correctly anchor on current first-party docs:

- CLI session management says chat is stored in a database under `~/.kiro/`
- the same docs say `/chat save` and `/chat load` operate on JSON exports
- ACP docs say ACP sessions live under `~/.kiro/sessions/cli/`
- ACP docs say interactive chat uses ACP internally

`agentlytics` does not reflect those current public surfaces in either `editors/kiro.js` or `mod.ts`.

### 5.2 Better separation of fact vs inference

Our docs repeatedly say:

- the parser path is not publicly documented
- the old JSON shape may be real, legacy, or obsolete
- "Kiro stores no tool call data" is not proven

That is the right stance. `agentlytics` code bakes in several assumptions silently:

- base64 workspace-folder decoding
- `workspace-sessions/sessions.json`
- `.chat` snapshot grouping by `executionId`
- system-prompt stripping rules
- workspace recovery from `context[].id`

Some may be right. The point is that `agentlytics` does not label them as assumptions.

### 5.3 Less destructive reconstruction for legacy JSON

When our parser does match a file, it is less opinionated:

- it does not drop messages that start with `# `
- it does not strip XML-ish wrappers
- it does not infer titles from prompt surgery
- it does not truncate tool-text because it does not attempt tool parsing at all

That is weaker overall coverage, but lower heuristic risk on the one shape it accepts.

## 6. Confirmed mismatches

### 6.1 Both implementations miss the documented public Kiro storage surfaces

Confirmed by first-party docs:

- CLI session management documents SQLite-backed storage under `~/.kiro/`
- ACP documents `~/.kiro/sessions/cli/` with `.json` plus `.jsonl`
- ACP docs also say "Interactive Chat" uses ACP internally

Neither parser reads:

- the CLI SQLite store under `~/.kiro/`
- the ACP session log under `~/.kiro/sessions/cli/`

So both are mismatched against current public Kiro documentation.

### 6.2 Our parser path is the least supported one

`/Users/yigitkonur/dev/cli-continues/src/parsers/kiro.ts` uses:

- `~/Library/Application Support/Kiro/workspace-sessions/`

I found no first-party documentation or first-party issue-log evidence for that exact root.

By contrast, `agentlytics` uses:

- `.../User/globalStorage/kiro.kiroagent/...`

which is supported by first-party issue logs on Linux, macOS, and Windows. That does not prove its full subtree assumptions, but it does mean its root path is better evidenced than ours.

### 6.3 Agentlytics has a structured tool-call gap even when tool messages exist

This is a code-confirmed mismatch between `agentlytics` behavior and Kiro's documented ACP semantics.

First-party ACP docs say Kiro emits:

- `ToolCall`
- `ToolCallUpdate`

with tool invocation data during sessions.

But in `agentlytics`:

- `editors/kiro.js` emits `tool` messages, not `_toolCalls`
- `cache.js` only stores structured tool calls from `_toolCalls` or `[tool-call: ...]` assistant markers

Result:

- Kiro tool activity may appear as raw tool-message text
- tool names and arguments are often missing from `tool_calls` analytics

This is better than our current "no tool summaries at all", but still well below documented ACP fidelity.

### 6.4 Our current "Kiro has no tool call data" behavior is outdated at the product level

The claim inside `/Users/yigitkonur/dev/cli-continues/src/parsers/kiro.ts` is only true for the specific legacy JSON shape it reads.

At the product level, first-party ACP docs contradict the broader implication:

- Kiro exposes `ToolCall` and `ToolCallUpdate`
- interactive chat uses ACP internally
- ACP sessions are persisted as event logs

So the current parser behavior is not just incomplete; it is now incomplete relative to documented Kiro capabilities.

## 7. Still unresolved

### 7.1 Is `workspace-sessions/.../sessions.json` still a live Kiro format?

Best case for `agentlytics`:

- the extension root is real
- old or current Kiro IDE builds may still keep a structured `workspace-sessions` index there

Best case against:

- no first-party doc or issue log in this review showed `workspace-sessions` or `sessions.json`
- current public docs describe CLI SQLite plus ACP `.json/.jsonl`, not this layout

Status: unresolved.

### 7.2 How much of `.chat` parsing is correct beyond the file extension itself?

Best case for `agentlytics`:

- first-party issue logs show `.chat` files are written under `.../kiro.kiroagent/...`
- issue logs around execution history make `executionId`-style grouping plausible

Best case against:

- I did not obtain a first-party sample `.chat` file
- fields like `metadata.workflow`, `context[]`, `executionId`, and message-role schema remain code-inferred

Status: unresolved.

### 7.3 How exactly do interactive chat, CLI SQLite, and ACP persistence relate?

The docs currently say two things:

- CLI chat is auto-saved to a SQLite-backed store under `~/.kiro/`
- interactive chat uses ACP internally, and ACP persists sessions under `~/.kiro/sessions/cli/`

Possible interpretations:

- Kiro keeps two layers for the same conversation lifecycle
- the SQLite store handles chat/session management, while ACP `.jsonl` handles event-level transcripts
- the docs describe adjacent but not identical surfaces

I could not verify the exact relationship from first-party docs alone.

### 7.4 Does the Kiro IDE still expose a separate app-private execution-history store?

The IDE docs confirm:

- sessions/history UI exists
- execution history includes code changes, commands, search results, file operations, and more

That strongly suggests richer internal storage than our parser reads today. It still does not publish the on-disk schema.

Status: unresolved.

## 8. URLs

- Kiro CLI chat docs: https://kiro.dev/docs/cli/chat/
- Kiro CLI session management docs: https://kiro.dev/docs/cli/chat/session-management/
- Kiro CLI ACP docs: https://kiro.dev/docs/cli/acp/
- Kiro IDE chat docs: https://kiro.dev/docs/chat/
- Kiro CLI slash commands: https://kiro.dev/docs/cli/reference/slash-commands/
- Agentlytics Kiro adapter: https://raw.githubusercontent.com/f/agentlytics/master/editors/kiro.js
- Agentlytics base helpers: https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
- Agentlytics editor registry: https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
- Agentlytics sandboxed entrypoint: https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- Agentlytics analytics cache: https://raw.githubusercontent.com/f/agentlytics/master/cache.js
- Kiro issue #1127: https://github.com/kirodotdev/Kiro/issues/1127
- Kiro issue #670: https://github.com/kirodotdev/Kiro/issues/670
- Kiro issue #1749: https://github.com/kirodotdev/Kiro/issues/1749
- Kiro issue #3454: https://github.com/kirodotdev/Kiro/issues/3454

# Antigravity parser comparison: `continues` vs `agentlytics`

**Scope:** Antigravity-specific storage, message extraction, tool/activity recovery, and artifact/MCP surface comparison between this repo and `f/agentlytics`. This does not attempt to reverse-engineer the full `.pb` schema.
**Last updated:** 2026-04-15

## 1. Summary

`agentlytics` has the broader Antigravity adapter today. Its `editors/antigravity.js` covers three distinct surfaces: live language-server RPC, offline SQLite-backed trajectory summaries, and project/session artifact discovery. Our parser in `src/parsers/antigravity.ts` only covers one legacy-looking surface: JSON or JSONL line logs under `~/.gemini/antigravity/code_tracker/`.

The deeper problem is not just feature breadth. It is source truth. Current local evidence and our own Antigravity docs under `docs/parser-documentation/*/14-antigravity.md` show that present-day installs expose `~/.gemini/antigravity/conversations/*.pb`, `brain/`, `browser_recordings/`, and a VS Code-like app-data store with `User/globalStorage/state.vscdb`. That contradicts our parser's assumption that `code_tracker` is the primary conversation substrate, but it also means some `agentlytics` assumptions are only partly right: its SQLite path is confirmed, while its MCP config path is wrong on this machine.

Net: `agentlytics` is stronger on extraction, but our repo is stronger on epistemic hygiene because our parser docs explicitly flag uncertainty, split storage/message/tool assumptions apart, and already document the possibility that `code_tracker` is auxiliary rather than canonical.

## 2. Agentlytics parser surface

Primary file: `f/agentlytics/editors/antigravity.js`

- Live session discovery:
  - `getChats()` calls `GetAllCascadeTrajectories` over the local Antigravity language-server RPC and maps `summary`, `createdTime`, `lastModifiedTime`, workspace folder, step count, and model IDs into chat metadata.
  - File: `editors/antigravity.js`, around lines 624-650.
- Live message extraction:
  - `getSteps()` prefers `GetCascadeTrajectorySteps`, then falls back to `GetCascadeTrajectory`.
  - `parseStep()` maps many Antigravity/Cortex step types into normalized `user`, `assistant`, and `tool` messages, including planner responses, command runs, file views, code actions, grep, directory listing, and MCP tool steps.
  - Files: `editors/antigravity.js`, around lines 653-850.
- Tail recovery:
  - `getTailMessages()` uses `trajectory.generatorMetadata[].chatModel.messagePrompts` to recover conversation tail content when step lists are truncated.
  - File: `editors/antigravity.js`, around lines 665-725.
- Offline fallback:
  - `readGlobalStateValue()` reads `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`.
  - `getOfflineChats()` looks for `antigravityUnifiedStateSync.trajectorySummaries` or `unifiedStateSync.trajectorySummaries`, then decodes nested base64/protobuf-like payloads to recover title, folder, timestamps, and bubble counts.
  - Files: `editors/antigravity.js`, around lines 232-439.
- Model normalization and usage:
  - `GetUserStatus` is used both for model label normalization and for usage/quota extraction.
  - Files: `editors/antigravity.js`, around lines 35-67 and 857-930.
- Artifact scanning:
  - `getArtifacts(folder)` scans `.gemini/skills`, `.gemini/rules`, `.gemini/plans`, `.gemini/workflows`, then joins per-session `brain/<session-id>/{task.md,implementation_plan.md,walkthrough.md}` artifacts back to the workspace folder.
  - File: `editors/antigravity.js`, around lines 957-1008.
- MCP discovery:
  - `getMCPServers()` assumes a global config at `~/.codeium/antigravity/mcp_config.json`.
  - File: `editors/antigravity.js`, around lines 1010-1017.

Discussion:

- Case for agentlytics:
  - It matches the product’s public framing better. Google’s launch post describes Antigravity as an agentic platform spanning editor, terminal, browser, manager surface, and artifacts; the `agentlytics` adapter actually tries to read those richer surfaces instead of flattening Antigravity to plain chat text.
- Case against agentlytics:
  - Several parts are heuristic or environment-dependent. Live RPC requires a running Antigravity language server. The protobuf decoding is field-number inference, not a published schema. The MCP path assumption is not confirmed by first-party docs and is contradicted locally here.

## 3. Our parser surface

Primary file: `/Users/yigitkonur/dev/cli-continues/src/parsers/antigravity.ts`

- Storage assumption:
  - `ANTIGRAVITY_BASE_DIR` is hardcoded to `${GEMINI_CLI_HOME|$HOME}/.gemini/antigravity/code_tracker`.
  - File: `/Users/yigitkonur/dev/cli-continues/src/parsers/antigravity.ts`, lines 13-18.
- File discovery:
  - `findSessionFiles()` recursively scans immediate `code_tracker` subdirectories for `*.json` and `*.jsonl`.
  - File: `/Users/yigitkonur/dev/cli-continues/src/parsers/antigravity.ts`, lines 105-119.
- Message assumption:
  - Every useful line is expected to reduce to JSON with `{ type, content, timestamp }` after removing a binary prefix up to the first `{`.
  - Files: `/Users/yigitkonur/dev/cli-continues/src/parsers/antigravity.ts`, lines 36-68.
- Session indexing:
  - Only `type === 'user'` or `type === 'assistant'` entries count.
  - `cwd` is always empty.
  - `repo` is derived from the directory name by trimming a trailing hash suffix.
  - File: `/Users/yigitkonur/dev/cli-continues/src/parsers/antigravity.ts`, lines 138-181.
- Context extraction:
  - `extractAntigravityContext()` only returns recent user/assistant messages.
  - `filesModified`, `pendingTasks`, `toolSummaries`, and `sessionNotes` are always empty.
  - File: `/Users/yigitkonur/dev/cli-continues/src/parsers/antigravity.ts`, lines 184-234.
- Documentation surface:
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/14-antigravity.md`
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/14-antigravity.md`
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/14-antigravity.md`
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/14-antigravity.md`
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/14-antigravity.md`

Discussion:

- Case for our parser:
  - It is small, readable, streamed with `readline`, and conservative about what it emits.
  - The docs already warn that `code_tracker` may now be auxiliary, which avoids falsely presenting the parser as high-confidence.
- Case against our parser:
  - On current local evidence it likely misses real Antigravity sessions entirely, because current conversations are `.pb` files under `~/.gemini/antigravity/conversations/`, not JSON/JSONL transcripts under `code_tracker/`.

## 4. Where agentlytics is stronger

- It treats Antigravity as a multi-surface product, not just a chat log.
  - Evidence: `editors/antigravity.js` covers live RPC, offline summary cache, artifacts, MCP, and usage.
- It recovers tool and planner activity.
  - Our parser emits no tool activity at all; `agentlytics` maps planner responses, tool executions, commands, file views, code actions, grep, list-directory, and MCP steps.
- It recovers workspace folder identity far better.
  - Live chats use `summary.workspaces[0].workspaceFolderAbsoluteUri`.
  - Offline chats derive folder hints from decoded summary payloads.
  - Our parser sets `cwd: ''` and derives `repo` from hashed directory names.
- It has a credible offline fallback that is confirmed locally.
  - Local machine confirmation:
    - `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` exists and is a SQLite database.
    - Querying `ItemTable` shows the exact key `antigravityUnifiedStateSync.trajectorySummaries`.
- It maps Antigravity’s artifact-centric workflow better.
  - Google’s launch post explicitly says agents produce artifacts like task lists, implementation plans, screenshots, and browser recordings.
  - `agentlytics` surfaces `brain/` task docs and scans workspace `.gemini/*` artifacts; our parser ignores all of that.

## 5. Where our parser/docs are stronger

- Our docs separate storage, message schema, tool-call map, access recipes, and handoff pointers into independent documents.
  - `agentlytics` keeps Antigravity logic in one large adapter file, which is operationally effective but less auditable.
- Our docs are more explicit about uncertainty.
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/14-antigravity.md`
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/14-antigravity.md`
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/14-antigravity.md`
  - These already state that `conversations/*.pb` appears primary and `code_tracker` appears auxiliary.
- Our shared handoff architecture is more disciplined than `agentlytics`’ per-editor flattening.
  - `/Users/yigitkonur/dev/cli-continues/src/utils/tool-summarizer.ts` centralizes category-aware summaries and file tracking.
  - `/Users/yigitkonur/dev/cli-continues/src/utils/markdown.ts` centralizes rendering order and section caps.
  - `/Users/yigitkonur/dev/cli-continues/src/config/verbosity.ts` gives a typed, preset-driven verbosity layer.
  - `agentlytics` instead embeds truncation, preview, and message-format choices directly inside each editor adapter.
- Our parser does not currently overclaim live support.
  - `agentlytics`’ best Antigravity path requires a running editor and local language server. That is powerful, but also operationally brittle.

## 6. Confirmed mismatches

- Confirmed mismatch: our parser’s canonical storage assumption is wrong for the current local install.
  - Our code:
    - `/Users/yigitkonur/dev/cli-continues/src/parsers/antigravity.ts`, lines 13-18 and 105-119
  - Local evidence:
    - `~/.gemini/antigravity/conversations/*.pb` exists in bulk.
    - Sample `file` output identifies a `.pb` conversation artifact as binary data.
    - `~/.gemini/antigravity/code_tracker/active/...` contains hashed file snapshots like `*_CLAUDE.md`, `*.tsx`, and `*.json`, not session transcripts.
  - Verdict:
    - `code_tracker` is not the safe default primary transcript source.

- Confirmed mismatch: `agentlytics`’ Antigravity MCP path is wrong on this machine.
  - Agentlytics code:
    - `f/agentlytics/editors/antigravity.js`, lines 1010-1017, assumes `~/.codeium/antigravity/mcp_config.json`.
  - Local evidence:
    - `~/.codeium/antigravity/` does not exist here.
    - `~/.gemini/antigravity/mcp_config.json` does exist.
  - Verdict:
    - The current `agentlytics` MCP path should be treated as unverified product knowledge, not canonical truth.

- Confirmed mismatch: our parser’s message model is materially narrower than Antigravity’s public product shape.
  - Our code:
    - `/Users/yigitkonur/dev/cli-continues/src/parsers/antigravity.ts`, lines 184-234, always returns empty tool summaries, pending tasks, files modified, and session notes.
  - First-party product evidence:
    - Google’s launch post says Antigravity agents plan, execute, and verify across editor, terminal, and browser, then communicate via artifacts such as task lists, implementation plans, screenshots, and browser recordings.
  - Verdict:
    - Even if our parser found the right transcript surface, its normalization target is still underspecified for Antigravity.

- Confirmed match in favor of agentlytics: the offline SQLite surface is real.
  - Agentlytics code:
    - `f/agentlytics/editors/antigravity.js`, lines 232-439.
  - Local evidence:
    - `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` exists.
    - SQLite `ItemTable` contains `antigravityUnifiedStateSync.trajectorySummaries`.
  - Verdict:
    - This is a legitimate local evidence source, even if the protobuf field mapping remains heuristic.

## 7. Still unresolved

- Unresolved: the canonical schema for `~/.gemini/antigravity/conversations/*.pb`.
  - First-party public docs reviewed here do not publish the protobuf shape.
- Unresolved: whether `code_tracker` still contains recoverable conversation/session material in some Antigravity builds, or only auxiliary code-tracking artifacts.
  - Our fixtures and parser imply a legacy or internal variant still exists somewhere.
- Unresolved: whether `agentlytics`’ protobuf field mapping for offline summaries is stable across Antigravity versions.
  - The key exists locally, but field-number interpretation was inferred from bytes, not documented upstream.
- Unresolved: live RPC path verification for Antigravity in this environment.
  - No Antigravity language-server process was observed during this audit, so `GetAllCascadeTrajectories` / `GetCascadeTrajectorySteps` were not directly exercised here.

## 8. URLs

- `f/agentlytics` Antigravity adapter:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/antigravity.js
- `f/agentlytics` shared base:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
- `f/agentlytics` editor registry:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
- Google Antigravity launch post:
  - https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/
- Google Antigravity docs home:
  - https://antigravity.google/docs/home
- Google Antigravity browser docs:
  - https://antigravity.google/docs/browser
- Google Gemini CLI tracker service:
  - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/trackerService.ts
- Google Gemini CLI storage paths:
  - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/storage.ts

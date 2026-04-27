# Copilot parser/docs comparison: `continues` vs agentlytics

## 1. Summary

Both codebases are grounded in Copilot CLI's per-session `events.jsonl` stream under `session-state/`, and both infer extra structure from local files that GitHub does not fully specify. The main difference is emphasis: `continues` is more conservative for handoff generation and documents the native Copilot storage model more accurately, while agentlytics is stronger at session-wide analytics once a session has already been discovered.

The biggest confirmed gaps are shared. Neither `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` nor `https://raw.githubusercontent.com/f/agentlytics/master/editors/copilot.js` honors documented `COPILOT_HOME` / `--config-dir` overrides, and neither uses Copilot's native `session-store.db` tables (`sessions`, `turns`, `session_files`) for discovery or fallback. Both also underuse the raw event stream by ignoring `tool.execution_*` result events even though those events are present in local `events.jsonl`.

## 2. Agentlytics parser surface

Agentlytics has two Copilot surfaces:

- `https://raw.githubusercontent.com/f/agentlytics/master/editors/copilot.js`
- `https://raw.githubusercontent.com/f/agentlytics/master/mod.ts`

`editors/copilot.js` is the fuller parser. It reads `~/.copilot/session-state/<id>/workspace.yaml` and `events.jsonl`, skips sessions without `workspace.yaml`, skips sessions whose `user.message` + `assistant.message` count is zero, derives the session model from the first `session.shutdown`, and emits all user and assistant messages from the full event log. It also extracts tool calls from `assistant.message.data.toolRequests[]`, preserves raw tool names and parsed args, and aggregates `session.shutdown.data.modelMetrics` token totals into the first assistant message. In `cache.js`, those `_toolCalls`, `_inputTokens`, `_outputTokens`, and `_cacheRead` fields are persisted into agentlytics' own derived SQLite cache.

`mod.ts` is materially weaker for Copilot. Its `scanCopilot()` scanner only counts `user.message` and `assistant.message`, does not parse messages at all, and pushes a session row for every subdirectory under `~/.copilot/session-state/` even when `workspace.yaml` or `events.jsonl` are missing. That means the Deno "sandboxed edition" can overcount empty or partial sessions that the full adapter would drop.

`editors/index.js` registers the full Copilot adapter under `copilot-cli`. `editors/base.js` provides shared helpers but no Copilot-specific path resolution for `COPILOT_HOME` or `--config-dir`.

## 3. Our parser surface

`/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` is narrower than agentlytics' full adapter but cleaner for handoff use. It:

- discovers sessions only in `~/.copilot/session-state/`
- requires `workspace.yaml` to exist before considering a directory a session
- computes bytes/line counts from `events.jsonl`
- filters final sessions to `bytes > 0`
- extracts the selected model from `session.start.data.selectedModel`
- builds handoff context from recent `user.message` and `assistant.message` events only
- summarizes tool usage only from `assistant.message.data.toolRequests[]`
- records modified files only when a tool name maps to `write` or `edit` through `classifyToolName()`

The surrounding docs are substantially broader than the parser:

- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/03-copilot.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/03-copilot.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/03-copilot.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/03-copilot.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/03-copilot.md`

Those docs correctly call out `session-store.db`, native raw-vs-index separation, `COPILOT_HOME`, `--config-dir`, `session.db`, `rewind-snapshots`, and the fact that `events.jsonl` is append-only and can span multiple `session.resume` segments.

## 4. Where agentlytics is stronger

- `https://raw.githubusercontent.com/f/agentlytics/master/editors/copilot.js` extracts session-wide token metrics from `session.shutdown.data.modelMetrics`. `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` does not expose any token or cache-read counts.
- Agentlytics preserves raw tool names and raw parsed args in `_toolCalls`, then persists them through `https://raw.githubusercontent.com/f/agentlytics/master/cache.js`. `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` keeps raw names in samples, but it also collapses them into generic categories for file-mod tracking and drops tools in `SKIP_TOOLS`.
- Agentlytics reads the full conversation, not just a recent window. That is better for retrospective analytics and cost accounting, even if it is noisier for handoff.
- Agentlytics attaches a first-session-wide model and token picture from `session.shutdown`; that is useful when the goal is dashboards rather than precise replay.

## 5. Where our parser/docs are stronger

- The docs in `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/.../03-copilot.md` track GitHub's first-party storage docs more accurately than agentlytics does. They explicitly separate native raw storage (`session-state/<id>/events.jsonl`) from the native index (`session-store.db`), which matches GitHub's docs and the local `sessions` / `turns` / `session_files` tables.
- Our docs explicitly mention the documented config-root overrides `COPILOT_HOME` and `--config-dir`. Agentlytics hardcodes `~/.copilot` in both `editors/copilot.js` and `mod.ts`.
- `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` is safer than agentlytics' `mod.ts` scanner for session discovery because it requires `workspace.yaml` and excludes sessions with zero `events.jsonl` bytes.
- Our docs correctly note that `session.db` is not the main transcript store. On this machine, sampled per-session `session.db` files mostly contain `todos` and `todo_deps`, while the global `session-store.db` holds normalized `sessions`, `turns`, and `session_files`.
- For handoff, our truncation and recent-message focus are intentional. That loses fidelity, but it avoids flooding the downstream agent with Copilot-specific hook noise that appears in raw logs.

## 6. Confirmed mismatches

### Storage assumptions

- GitHub documents `~/.copilot` as the default config dir, but also documents `COPILOT_HOME` and `--config-dir` overrides. Neither `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` nor `https://raw.githubusercontent.com/f/agentlytics/master/editors/copilot.js` nor `https://raw.githubusercontent.com/f/agentlytics/master/mod.ts` honors those overrides.
- GitHub documents `session-store.db` as a native SQLite store for cross-session indexing and search. Local verification shows populated `sessions`, `turns`, and `session_files` tables. Neither parser uses it.
- `workspace.yaml` is real and widely present locally, but GitHub's public docs only guarantee `events.jsonl` plus "workspace artifacts". So both parsers rely on a de facto file that is not yet a formally documented contract.

### Session discovery

- `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` only discovers directories with `workspace.yaml`, then filters out zero-byte `events.jsonl`. This is conservative and misses any future session variant that lacks either assumption.
- `https://raw.githubusercontent.com/f/agentlytics/master/editors/copilot.js` also requires `workspace.yaml`, but then additionally drops sessions with no user/assistant messages.
- `https://raw.githubusercontent.com/f/agentlytics/master/mod.ts` is looser than both: it emits a session row for every directory under `session-state/`, even if the session has no `workspace.yaml` and no messages. This is a real internal agentlytics mismatch between its two Copilot implementations.

### Transcript completeness

- Both parsers only treat `user.message` and `assistant.message` as conversational content.
- Local Copilot logs also contain `tool.execution_start`, `tool.execution_complete`, `hook.start`, `hook.end`, `assistant.turn_start`, `assistant.turn_end`, `session.resume`, and `session.shutdown`.
- This matters because `tool.execution_complete` contains tool results, and those results can be large and semantically important. `assistant.message.data.toolRequests[]` only describes intended tool invocations, not what actually happened.
- Agentlytics partially compensates by embedding `[tool-call: name(keys)]` placeholders into assistant content and storing `_toolCalls`, but it still does not ingest `tool.execution_complete` outputs.
- `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` currently states that "Copilot doesn't provide tool results," which is contradicted by local `events.jsonl` evidence showing `tool.execution_complete.data.result`.

### Subset / index surfaces

- Native Copilot already exposes normalized subsets: `session-store.db.sessions`, `turns`, and `session_files`.
- Agentlytics ignores those native subsets, then creates its own derived `cache.db` message and tool-call index in `https://raw.githubusercontent.com/f/agentlytics/master/cache.js`.
- `continues` ignores both the native SQLite index and any derived index; it works only from raw per-session files.
- Native `session_files` is materially richer than our current file-mod tracking because it carries `file_path`, `tool_name`, and `turn_index`, whereas `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` only infers modified files from tool names classified as write/edit inside `assistant.message.data.toolRequests[]`.

### Verbosity / summarization implications

- Agentlytics favors completeness. It reads the full session, persists messages, and stores up to 50k characters per message in its cache. This is better for dashboards and mining, but it also preserves Copilot hook noise and synthetic tool-call placeholders inside assistant content.
- `continues` favors handoff brevity. It only reads the recent tail, trims the final conversation window, truncates session summaries to 60 chars, and truncates tool sample argument JSON to 100 chars. That is usually better for continuation prompts, but weaker for forensic replay.
- Agentlytics' token attribution is convenient but coarse. Because aggregate `session.shutdown.modelMetrics` totals are attached to the first assistant message, downstream analytics can easily misread session-level totals as turn-level totals.

## 7. Still unresolved

- Whether GitHub intends `workspace.yaml` to remain stable enough for parser contracts, or whether tooling should degrade to `events.jsonl` + `session-store.db` when it is absent.
- Whether Copilot's public docs will eventually specify a canonical location for tool results and file modifications beyond the current high-level statement that session data includes them.
- Whether `session.db` will stay mostly todo-oriented or gain broader transcript semantics in future Copilot versions.
- Whether `session.resume` boundaries should be preserved in handoff output or compacted into a single logical transcript.

See `99-open-issues.md` for action-oriented follow-ups.

## 8. URLs

- GitHub Docs, Copilot CLI config directory: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
- GitHub Docs, Copilot CLI chronicle concepts: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- GitHub Docs, Copilot CLI chronicle how-to: https://docs.github.com/en/copilot/how-tos/copilot-cli/chronicle
- GitHub issue #2396, persisted session-state fields: https://github.com/github/copilot-cli/issues/2396
- GitHub issue #2209, long-lived resumed sessions: https://github.com/github/copilot-cli/issues/2209
- agentlytics full Copilot adapter: https://raw.githubusercontent.com/f/agentlytics/master/editors/copilot.js
- agentlytics shared editor helpers: https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
- agentlytics editor registry: https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
- agentlytics Deno scanner: https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- agentlytics derived cache layer: https://raw.githubusercontent.com/f/agentlytics/master/cache.js

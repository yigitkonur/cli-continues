# Open issues for Copilot parser comparison

## 1. Native path resolution

Question: should `/Users/yigitkonur/dev/cli-continues/src/parsers/copilot.ts` support `COPILOT_HOME` and `--config-dir` parity with GitHub's documented config-root rules?

Why it is open:

- GitHub documents both overrides.
- The current parser hardcodes `~/.copilot/session-state`.
- Agentlytics hardcodes the same path, so external comparison does not settle the intended behavior.

Likely answer:

- Yes. This is a confirmed parser gap, not just a docs nicety.

## 2. Discovery fallback via `session-store.db`

Question: should session discovery and indexing fall back to native SQLite tables when `workspace.yaml` or `events.jsonl` is missing, partial, or too large?

Why it is open:

- GitHub documents `session-store.db` for cross-session indexing and search.
- Local evidence shows populated `sessions`, `turns`, and `session_files` tables.
- Some session directories contain `workspace.yaml` and `session.db` but no `events.jsonl`.

Likely answer:

- Yes for discovery and enrichment; maybe no for canonical transcript replay. The SQLite store looks like a native subset/index surface, not the full-fidelity raw log.

## 3. Tool-result fidelity

Question: should the parser ingest `tool.execution_complete` and hook events instead of relying only on `assistant.message.data.toolRequests[]`?

Why it is open:

- Local `events.jsonl` shows `tool.execution_complete.data.result`.
- Current `continues` docs and parser still assume Copilot does not provide tool results.
- Agentlytics also stops at `toolRequests`, so comparison does not provide a stronger alternative.

Likely answer:

- Yes, at least behind a verbosity gate. Tool results are present, but ingesting them blindly could bloat handoffs.

## 4. File modification source of truth

Question: should modified-file tracking come from native `session_files` instead of inferred write/edit tool calls?

Why it is open:

- Local `session-store.db.session_files` rows include `file_path`, `tool_name`, and `turn_index`.
- Current `continues` tracking depends on `classifyToolName()` recognizing a tool as write/edit.
- Unknown tools currently fall into `mcp`, so true file changes can be missed.

Likely answer:

- Yes for accuracy, with raw-event inference retained as fallback when the SQLite index is stale or absent.

## 5. Resume segmentation

Question: should resumed Copilot sessions remain segmented in downstream output?

Why it is open:

- First-party issue #2209 shows real sessions with multiple `session.resume` segments in one `events.jsonl`.
- Neither parser models those boundaries explicitly.
- For analytics, compaction may be fine. For replay/debugging, segment boundaries can explain odd context resets and inflated line counts.

Likely answer:

- Preserve them internally; decide at render time whether to compact or expose them.

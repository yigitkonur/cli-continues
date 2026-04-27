# OpenCode parser/docs comparison: `continues` vs agentlytics

**Scope:** Compare only OpenCode handling in `continues` and agentlytics against first-party OpenCode code and local OpenCode data. This covers storage backend detection, message/part extraction, tool-call fidelity, and verbosity/summarization behavior.
**Last updated:** 2026-04-15
**Confidence:** High — local code, agentlytics first-party code, and current OpenCode first-party code largely agree on the main facts; a few ordering details remain unresolved.

## 1. Summary

OpenCode upstream is SQLite-first today, with legacy JSON storage retained for migration and fallback. On that point, `/Users/yigitkonur/dev/cli-continues/src/parsers/opencode.ts` is directionally closer to upstream than agentlytics’ `editors/opencode.js`, and much closer than agentlytics’ `mod.ts`, which only scans flat JSON files under `storage/session`.

Agentlytics is stronger at preserving conversational surface from OpenCode parts: its `https://raw.githubusercontent.com/f/agentlytics/master/editors/opencode.js` keeps text, reasoning, tool-call placeholders, and tool-result previews, while `continues` currently keeps only `text` parts from both SQLite and JSON storage. That makes agentlytics more verbose and more analytically useful for message browsing, but it achieves that by collapsing structured tool parts into lossy bracketed strings.

`continues` has a sharper documentation layer than its implementation. The local docs under `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/.../05-opencode.md` correctly describe upstream tool parts, dual backends, and migration drift better than either parser. But the actual parser does not honor `OPENCODE_DB` or channel-specific DB filenames, and its OpenCode tool summary extraction only reads legacy JSON session files, so DB-only installs can lose all tool summaries.

## 2. Agentlytics parser surface

Agentlytics has two OpenCode surfaces, and they do not agree.

- Full adapter surface:
  - `https://raw.githubusercontent.com/f/agentlytics/master/editors/opencode.js`
  - Registered through `https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js`
  - Used by the cache/analyzer in `https://raw.githubusercontent.com/f/agentlytics/master/cache.js`
- Sandboxed CLI surface:
  - `https://raw.githubusercontent.com/f/agentlytics/master/mod.ts`

Documented behavior in `editors/opencode.js`:

- Storage assumptions:
  - Hardcodes JSON root to `~/.local/share/opencode/storage` and DB path to `~/.local/share/opencode/opencode.db`.
  - Scans legacy JSON sessions recursively under `storage/session/<project>/ses_*.json` at lines 161-180.
  - Scans SQLite sessions separately at lines 71-79.
  - Prefers file sessions first, then appends unseen SQLite sessions at lines 280-325.
- Message extraction:
  - For SQLite, reads `message.data`, then all `part.data` rows ordered by `time_created` at lines 81-149.
  - For JSON, reads `storage/message/<session>` and `storage/part/<message>` at lines 192-271.
  - Emits:
    - raw text for `text`
    - `[thinking] ...` for `thinking` or `reasoning`
    - `[tool-call: tool(argKeys)]` for `tool-call`, `tool_use`, `tool-use`, or `tool`
    - `[tool-result] preview` for `tool-result` or `tool_result`, and also reads `state.output` when present
  - Skips `step-start` and `step-finish` in JSON mode.
  - If a message has no extracted content, inserts a placeholder like `[assistant]`.
- Metadata extraction:
  - Pulls model/provider/token/cache data from `message.data` in both SQLite and JSON paths.
- Analytics surface:
  - `cache.js` stores normalized messages, then extracts tool calls either from `msg._toolCalls` or via regex over `[tool-call: ...]` placeholders at lines 241-318.
  - The OpenCode adapter does not populate `_toolCalls`, so the regex path is the effective one for OpenCode.
- MCP surface:
  - `editors/opencode.js` reads `~/.config/opencode/opencode.json` and maps the `mcp` key at lines 343-372.
  - `editors/base.js` provides the generic config parser used elsewhere, but OpenCode uses a custom path and custom `mcp` key mapping.

Documented behavior in `mod.ts`:

- `mod.ts` only scans `~/.local/share/opencode/storage/session/*.json` flat at lines 748-773.
- It does not recurse into project subdirectories.
- It does not read SQLite at all.
- It sets `bubbleCount: 0` for every OpenCode session.

Inference:

- Agentlytics’ real OpenCode adapter is `editors/opencode.js`, not `mod.ts`.
- `mod.ts` is still a first-party agentlytics surface, so its OpenCode behavior is a confirmed product-level mismatch, not just dead code.

## 3. Our parser surface

Relevant local files:

- `/Users/yigitkonur/dev/cli-continues/src/parsers/opencode.ts`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/05-opencode.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/05-opencode.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/05-opencode.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/access-recipes/05-opencode.md`
- `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/handoff-pointers/05-opencode.md`

Implementation behavior in `/Users/yigitkonur/dev/cli-continues/src/parsers/opencode.ts`:

- Storage assumptions:
  - Builds base path from `XDG_DATA_HOME` or `~/.local/share/opencode` at lines 27-31.
  - Hardcodes DB path to `<base>/opencode.db`.
  - Tries SQLite first for sessions and messages at lines 195-203 and 327-335.
  - Falls back to legacy JSON session/project/message/part trees when SQLite is absent or empty.
  - Unlike agentlytics `mod.ts`, it correctly expects legacy JSON sessions under `storage/session/<project>/ses_*.json`.
- Session extraction:
  - SQLite: reads the `session` table and joins `project` only for `worktree` lookup at lines 209-278.
  - JSON: reads `storage/session/<project>/<session>.json` plus `storage/project/<project>.json` at lines 283-322.
  - For untitled sessions, both paths try to summarize from the first user text part.
- Message extraction:
  - SQLite: reads message rows ordered by `time_created`, then part rows ordered by `time_created`, and concatenates only `text` parts at lines 341-389.
  - JSON: same policy, only `text` parts at lines 394-450.
  - Any message with no `text` part disappears from `recentMessages`.
- Tool summary extraction:
  - `extractOpenCodeToolSummaries()` reads only legacy JSON session files under `storage/session/<project>/<session>.json` at lines 457-496.
  - It emits at most one synthetic `Edit` summary derived from `summary.additions`, `summary.deletions`, and `summary.files`.
  - It never reads SQLite `part` rows of `type: "tool"`.
  - It does not read SQLite `session.summary_*` either, even though upstream stores these fields on the `session` table.
- Handoff output:
  - `extractOpenCodeContext()` passes trimmed recent text-only messages plus tool summaries into the general markdown generator at lines 501-520.

Documentation surface:

- The docs correctly describe upstream SQLite-first storage, legacy JSON migration, and the rich OpenCode part schema.
- The docs explicitly say the parser currently omits reasoning/tool/patch/compaction parts from recent conversation.
- The docs are stronger than the implementation on DB path variants and tool-part richness, but a few claims overrun what the parser actually does today.

## 4. Where agentlytics is stronger

- Part extraction is richer. Agentlytics preserves reasoning text, tool-call placeholders, tool-result previews, and role-only placeholders; `continues` keeps only `text` parts.
- Message browsing is more verbose. For OpenCode sessions with heavy tool use, agentlytics exposes more of the assistant’s operational trace.
- Analytics are broader. Agentlytics extracts model/provider/token/cache metadata from message rows and stores tool names in its own cache DB, even if the tool arguments are lossy.
- OpenCode MCP config support exists. `editors/opencode.js` reads `~/.config/opencode/opencode.json` and maps `mcp` entries; `continues` OpenCode parsing does not cover this surface.

Tradeoff:

- That extra verbosity is partly synthetic. Agentlytics converts structured parts into bracketed text, so it is better for dashboards than for high-fidelity continuation.

## 5. Where our parser/docs are stronger

- Backend choice is closer to upstream. `continues` is SQLite-first, which matches current OpenCode upstream and the local installation on this machine.
- Legacy JSON traversal is more correct than agentlytics `mod.ts`. `continues` searches `storage/session/<project>/ses_*.json`, which matches OpenCode’s migration layout.
- The documentation is materially better than either parser:
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/05-opencode.md` correctly records that upstream tool parts are structured `type: "tool"` parts with `state.input`, `state.output` or `state.error`, timing, and optional attachments.
  - `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/05-opencode.md` and `handoff-pointers/05-opencode.md` correctly frame SQLite vs legacy JSON as a real migration/state issue.
- The handoff model is more conservative. By omitting reasoning/tool noise, `continues` produces terser resumable context. For some continuation targets that is a feature, not a bug.

Tradeoff:

- This terseness becomes under-informative for OpenCode specifically, because upstream stores important state in non-text parts.

## 6. Confirmed mismatches

### A. Upstream OpenCode vs agentlytics

1. **Backend priority is inverted in `editors/opencode.js`.**
   - Agentlytics comments call JSON the “newer storage format” and SQLite “older/primary” at `editors/opencode.js:284-307`.
   - First-party OpenCode code is SQLite-first now:
     - `packages/opencode/src/storage/db.ts:30-44` resolves the active DB path.
     - `packages/opencode/src/storage/storage.ts:88-247` contains JSON migration logic for legacy storage.
   - Local evidence on this machine also supports SQLite-first: `~/.local/share/opencode/opencode.db` exists, while `~/.local/share/opencode/storage/session` does not.

2. **Agentlytics hardcodes only `opencode.db`.**
   - `editors/opencode.js:16-21` hardcodes `~/.local/share/opencode/opencode.db`.
   - First-party OpenCode supports `OPENCODE_DB` and channel-specific DB filenames in `packages/opencode/src/storage/db.ts:31-44`.
   - Recommendation impact: agentlytics can miss non-default DB names or channel DBs.

3. **Agentlytics `mod.ts` does not match current OpenCode storage or its own full adapter.**
   - `mod.ts:748-773` scans only flat `storage/session/*.json`.
   - OpenCode legacy JSON migration layout is nested under `storage/session/<project>/...` in `packages/opencode/src/storage/storage.ts:145-215`.
   - Agentlytics `editors/opencode.js:161-180` already knows the nested layout, so the mismatch is internal to agentlytics.

4. **Agentlytics tool-call fidelity is lossy relative to upstream.**
   - Upstream `ToolPart` is structured in `packages/opencode/src/session/message-v2.ts:276-349`.
   - Agentlytics emits bracketed text placeholders at `editors/opencode.js:112-123` and `234-241`.
   - `cache.js:275-290` then stores only the parsed tool name and `{}` args unless another adapter populated `_toolCalls`.
   - Consequence: tool names survive, but exact arguments, outputs, errors, timings, attachments, and `callID` do not.

### B. Upstream OpenCode vs `continues`

5. **`continues` docs know about `OPENCODE_DB` and channel DBs, but the parser does not.**
   - Docs: `/Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/05-opencode.md:8-13`
   - Parser: `/Users/yigitkonur/dev/cli-continues/src/parsers/opencode.ts:27-31`
   - Result: the docs are correct against upstream, but the parser only looks for `<base>/opencode.db`.

6. **`continues` drops almost all upstream part structure.**
   - Upstream parts include `tool`, `reasoning`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `retry`, `compaction`, and `subtask` in `packages/opencode/src/session/message-v2.ts:386-404`.
   - Parser only concatenates `text` parts in SQLite and JSON modes at `/Users/yigitkonur/dev/cli-continues/src/parsers/opencode.ts:364-379` and `423-442`.
   - Consequence: assistant steps with no text vanish from `recentMessages`.

7. **`continues` tool summaries are legacy-JSON-only even though upstream stores summary fields and tool parts in SQLite.**
   - Parser summary extraction reads only `storage/session/.../<session>.json` at `/Users/yigitkonur/dev/cli-continues/src/parsers/opencode.ts:460-489`.
   - Upstream stores `summary_additions`, `summary_deletions`, and `summary_files` on the SQLite `session` table in `packages/opencode/src/session/session.sql.ts:29-38`.
   - Upstream also stores tool parts in SQLite `part.data` in `packages/opencode/src/session/message-v2.ts:344-349`.
   - On this machine there is no `storage/session` tree, so OpenCode tool summaries from `continues` will be empty on live data.

### C. `continues` vs agentlytics

8. **SQLite vs JSON fallback handling**
   - `continues` is SQLite-first, then JSON fallback.
   - agentlytics `editors/opencode.js` is file-first, then SQLite fallback.
   - agentlytics `mod.ts` is JSON-only.
   - Against current upstream, `continues` has the better default.

9. **Part extraction**
   - `continues`: text-only, terse, resumable, but under-informative.
   - agentlytics: richer and more verbose, but synthetic and lossy.

10. **Verbosity/summarization implications**
   - `continues` produces smaller handoffs with lower noise, but misses reasoning and tool execution context that often matters in OpenCode sessions.
   - agentlytics preserves more operational context, but its bracketed placeholders can overstate fidelity and inflate assistant message length with preview text instead of structured facts.

## 7. Still unresolved

- Canonical part ordering is not fully settled from the evidence gathered here.
  - Both parsers sort SQLite parts by `time_created`.
  - OpenCode’s client-side sync layer sorts parts by `id`, not `time_created`, in `packages/app/src/context/sync.tsx`.
  - I did not verify the exact server-side DB query used to materialize parts over the API.
- The exact product contract for agentlytics `mod.ts` versus the full adapter set is not documented in code beyond “Deno Sandboxed Edition”.
  - It is clearly a first-party surface.
  - It is not clear whether the OpenCode path there is intentionally degraded or simply stale.

See `99-open-issues.md` for the follow-up list.

## 8. URLs

- OpenCode repo redirect check:
  - https://github.com/sst/opencode
  - Redirects to `https://github.com/anomalyco/opencode` as of 2026-04-15
- First-party OpenCode code:
  - https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/db.ts
  - https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/storage.ts
  - https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/session.sql.ts
  - https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/message-v2.ts
- First-party agentlytics code:
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/opencode.js
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/base.js
  - https://raw.githubusercontent.com/f/agentlytics/master/editors/index.js
  - https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
  - https://raw.githubusercontent.com/f/agentlytics/master/cache.js

# Parser Redesign Backlog

This file turns the research package into an implementation sequence.

## P0: User-Facing Contract

### 1. Replace top-level preset language with a simpler human-facing contract

Current anchor:

- `src/config/verbosity.ts`
- `src/cli.ts`

Required outcome:

- user-facing flags and docs stop presenting `minimal | standard | verbose | full` as the main public model
- the default human-facing contract is simpler than today
- if needed, a separate machine/inspection axis remains explicit instead of being accidentally overloaded into one detail toggle
- existing internal rendering caps can stay behind the scenes if needed
- inspect/dump/resume/handoff behavior can still map to detailed internals without exposing four preset names as the main API

### 2. Add concise technical guidance near the top of the handoff

Current anchor:

- `src/utils/markdown.ts`
- `src/utils/resume.ts`

Required outcome:

- a concise technical pointer block appears before or alongside the main summary
- includes raw source path, backend format, session identifier, quick-inspect recipe, and confidence note
- the default human-facing view stays skimmable
- deeper/debug/full views expand with backend-specific retrieval depth without burying the main continuation summary

### 3. Separate raw fidelity from summarized tool categories

Current anchor:

- `src/utils/tool-summarizer.ts`
- `src/utils/markdown.ts`

Required outcome:

- grouped summaries can remain
- exact upstream tool/function names are preserved somewhere in the handoff or a raw appendix
- argument/result carrier information is not lost
- normalized aliases remain available in the default human summary where they improve readability

## P1: Parser Corrections By Risk

### 4. Gemini parser version detection

Current anchor:

- `src/parsers/gemini.ts`

Required outcome:

- detect and support legacy JSON and current JSONL append-log variants
- reconstruct effective history before trimming
- preserve tool-call fidelity from current upstream structures
- consider `projects.json` / short-id mapping for better workspace attribution where it is stable enough to trust

### 5. Kiro backend clarification and parser split

Current anchor:

- `src/parsers/kiro.ts`
- `src/parsers/registry.ts`

Required outcome:

- distinguish normal CLI SQLite storage under `~/.kiro/` from ACP session storage under `~/.kiro/sessions/cli/`
- decide whether this repo supports Kiro IDE, Kiro CLI, or both
- align discovery with the verified backend(s)
- surface uncertainty explicitly if both backends remain in play

### 6. Antigravity source-of-truth correction

Status: implemented for discovery and offline artifact handoff; live transcript/tool extraction is best-effort through private local RPC.

Current anchor:

- `src/parsers/antigravity.ts`

Required outcome:

- keep canonical discovery on `conversations/*.pb` + `brain/<id>/` + UI/index state
- keep `code_tracker` as legacy-only for chat-shaped JSON/JSONL
- preserve explicit confidence notes for offline `.pb` transcript decoding

### 7. Qwen Code runtime-root correction

Current anchor:

- `src/parsers/qwen-code.ts`
- `src/parsers/registry.ts`

Required outcome:

- use the correct runtime-root/env-var contract
- ensure current installs are discoverable
- align docs and code around `projects/.../chats/*.jsonl` as the primary transcript store rather than treating `tmp/` as a competing primary path

### 8. Crush and Amp discovery correction

Current anchor:

- `src/parsers/crush.ts`
- `src/parsers/amp.ts`
- `src/parsers/registry.ts`

Required outcome:

- correct DB/thread root assumptions
- make pointer blocks reflect actual raw locations
- downgrade Amp storage-path certainty until a first-party local transcript contract exists

### 9. Droid and Kilo Code backend-family clarification

Current anchor:

- `src/parsers/droid.ts`
- `src/parsers/cline.ts`
- `src/parsers/registry.ts`

Required outcome:

- downgrade Droid’s `sessions/...` path from canonical truth to confidence-graded observation unless stronger first-party proof is found
- evaluate whether first-party `projects/.../*.jsonl` transcript-path examples should become the documented default
- explicitly decide whether `kilo-code` stays in the Cline-family parser or gets its own backend path
- support the possibility that both extension-side `ui_messages.json` and shared-core/DB-backed storage are live product surfaces
- document that decision in code comments and docs

### 10. Qwen runtime/storage cleanup

Current anchor:

- `src/parsers/qwen-code.ts`
- `src/parsers/registry.ts`

Required outcome:

- treat `projects/.../chats/*.jsonl` as the primary transcript store
- treat `tmp/` and `history/` as auxiliary roots, not competing canonical transcript paths
- prefer `QWEN_RUNTIME_DIR` over older env-var assumptions

### 11. Codex archived sessions and token-count correction

Current anchor:

- `src/parsers/codex.ts`
- `src/types/schemas.ts`

Required outcome:

- scan both active `sessions/` and `archived_sessions/`
- parse `event_msg.token_count` from the current nested `payload.info.*` shape instead of relying on older flatter assumptions
- reassess coverage of modern response-item variants against current first-party Codex protocol

## P2: Message And Tool Fidelity

### 12. Tool-specific recent-message reconstruction

Current anchor:

- `src/parsers/claude.ts`
- `src/parsers/codex.ts`
- `src/parsers/gemini.ts`
- `src/parsers/opencode.ts`
- `src/parsers/qwen-code.ts`

Required outcome:

- reconstruct effective assistant/user chronology before trimming
- stop treating user-carried tool results as ordinary human turns
- keep assistant tool activity close enough to the conversation to remain strategically useful

### 13. Richer OpenCode and Crush extraction

Current anchor:

- `src/parsers/opencode.ts`
- `src/parsers/crush.ts`

Required outcome:

- leverage structured DB parts, not only flattened text
- preserve exact tool names and result states
- honor `OPENCODE_DB` and channel DB variants
- stop deriving OpenCode tool summaries only from legacy JSON session files when SQLite is authoritative

### 14. Cursor completeness warning

Current anchor:

- `src/parsers/cursor.ts`
- `src/utils/markdown.ts`

Required outcome:

- mark transcript completeness limits when raw storage is known to omit outputs or other fidelity
- align parser confidence with the stronger caution already present in the docs
- evaluate a confidence-graded secondary ingestion path for richer local Cursor state without presenting undocumented stores as canonical

### 15. Confidence-graded source labeling in handoffs and docs

Current anchor:

- `src/utils/markdown.ts`
- `src/parsers/registry.ts`
- docs under `docs/parser-documentation/`

Required outcome:

- distinguish vendor-documented facts from local observation and unresolved inference
- surface weaker storage claims as weaker instead of presenting them with the same confidence as first-party-documented paths
- make docs-vs-parser mismatches explicit when the docs have already advanced beyond the implementation

## P3: Docs, Tests, And Registry Hygiene

### 16. Shared artifact and MCP discovery layer

Current anchor:

- shared parser utilities under `src/utils/`
- `src/parsers/registry.ts`

Required outcome:

- add a shared artifact-scanning utility inspired by agentlytics’ `editors/base.js` + `editors/index.js`
- add shared MCP config discovery instead of keeping MCP knowledge only in docs
- keep this as parser-adjacent context, not UI-only metadata

### 17. Update registry help text to stop implying canonical truth

Current anchor:

- `src/parsers/registry.ts`

Required outcome:

- storage-path strings become clearly descriptive rather than authoritative
- variant-aware help text where necessary

### 18. Expand fixtures/tests for backend variants

Current anchor:

- `src/__tests__/fixtures/index.ts`
- `src/__tests__/unit-conversions.test.ts`
- parser-specific tests

Required outcome:

- tests cover legacy/current variants where research found drift
- regression tests explicitly protect the simplified human-facing contract plus any separate machine/inspection surface
- tests cover confidence-graded warnings for weaker backends where practical
- add fixtures or regression cases for the strongest agentlytics-vs-us mismatches where practical

### 19. Align README with current tool reality

Current anchor:

- `README.md`

Required outcome:

- update tool counts and capability descriptions
- explain the new handoff structure once implemented
- avoid overselling undocumented storage internals as stable product truth

### 20. If sessionr integration becomes a product feature, treat async as nondeterministic for new-session ID recovery

Current anchor:

- any future integration docs or code paths that invoke `sessionr`

Required outcome:

- prefer sync JSON output when deterministic created-session IDs are required
- do not assume `--new --async` can always tell you which session to read afterward
- if async is used, make the recovery path explicit and defensive

# Agentlytics Parser Comparison Master Summary

Access date: 2026-04-15

This directory compares `cli-continues` against `f/agentlytics` across the overlapping parser surfaces and mines reusable parser patterns from adjacent agentlytics editors.

## Document Index

| File | Description |
| --- | --- |
| [claude/01-claude-comparison.md](./claude/01-claude-comparison.md) | Claude-specific comparison and mismatches |
| [codex/01-codex-comparison.md](./codex/01-codex-comparison.md) | Codex-specific comparison and mismatches |
| [copilot/01-copilot-comparison.md](./copilot/01-copilot-comparison.md) | Copilot-specific comparison and mismatches |
| [cursor/01-cursor-comparison.md](./cursor/01-cursor-comparison.md) | Cursor-specific comparison and mismatches |
| [gemini/01-gemini-comparison.md](./gemini/01-gemini-comparison.md) | Gemini-specific comparison and mismatches |
| [kiro/01-kiro-comparison.md](./kiro/01-kiro-comparison.md) | Kiro-specific comparison and mismatches |
| [opencode/01-opencode-comparison.md](./opencode/01-opencode-comparison.md) | OpenCode-specific comparison and mismatches |
| [antigravity-and-adjacent/01-antigravity-comparison.md](./antigravity-and-adjacent/01-antigravity-comparison.md) | Antigravity-specific comparison and mismatches |
| [antigravity-and-adjacent/02-adjacent-patterns-and-non-overlap-gaps.md](./antigravity-and-adjacent/02-adjacent-patterns-and-non-overlap-gaps.md) | Shared parser ideas and implications for our non-overlap tools |

## Biggest Takeaways

### Where `cli-continues` is ahead

- Documentation discipline is stronger.
  - Our parser-documentation set usually separates confirmed fact, inference, unresolved uncertainty, and operator guidance better than agentlytics’ code-only surface.
- Shared rendering/verbosity architecture is stronger.
  - `src/config/verbosity.ts`, `src/utils/tool-summarizer.ts`, and `src/utils/markdown.ts` are cleaner and more reusable than agentlytics’ adapter-local preview/truncation style.
- Handoff-specific summarization is stronger.
  - We generally produce better continuation context once the raw parser has enough truth.

### Where agentlytics is ahead

- Backend ambition is higher.
  - Agentlytics more often uses secondary stores, migration paths, workspace DBs, or hidden local state instead of stopping at the easiest transcript surface.
- Analytics extraction is richer.
  - It preserves more assistant/tool/thinking surface for later analysis, especially for Claude, Codex, Cursor, and OpenCode.
- Artifact and MCP scanning are stronger.
  - The shared `base.js` + `index.js` pattern gives agentlytics a reusable artifact/MCP discovery layer that `continues` does not yet have.

## Highest-Confidence Implementation Gaps Revealed By The Comparison

- Gemini parser is still legacy-JSON-only, while our docs are already JSONL-first.
- Codex parser likely misreads modern `token_count` by expecting top-level fields instead of current nested `payload.info.*`.
- Copilot parser misses documented `COPILOT_HOME` / `--config-dir` handling and does not exploit native SQLite index surfaces.
- Cursor parser code still assumes more transcript completeness than our own docs justify.
- OpenCode parser is SQLite-first, but still under-reads SQLite by dropping non-text parts and DB-native summary/tool signals.
- Kiro parser still targets the wrong public surface and needs an explicit CLI/ACP split.
- Antigravity parser still centers the weakest substrate (`code_tracker`) instead of the stronger `.pb` + `brain/` + UI/index-state picture.
- Shared artifact/MCP discovery is a reusable adjacent pattern we should likely adopt.

## Confidence Map

### Strongly confirmed now

- Claude: our parser is stronger on session reconstruction, but still misses `toolUseResult`
- Codex: scan `archived_sessions` and fix token-count parsing
- Copilot: add `COPILOT_HOME` / `--config-dir` and use richer native surfaces
- Cursor: add an explicit completeness warning and consider a confidence-graded second ingestion path
- Gemini: move to JSONL-first with replay semantics
- Kiro: split normal CLI SQLite from ACP JSON/JSONL
- OpenCode: honor SQLite richness, `OPENCODE_DB`, and non-text parts
- Antigravity: stop treating `code_tracker` as the safe canonical transcript source

### Still confidence-graded

- Amp local transcript schema/path
- Droid `projects/...` vs `sessions/...` coexistence/versioning
- Kilo extension-side legacy artifacts vs canonical live runtime
- exact same-tool debug UX
- exact machine-readable prompt-debug shape

## Action Implication

The next implementation pass should use this corpus as a parser-priority input, not just as reference reading. The highest value is not in copying agentlytics. It is in:

1. fixing the high-confidence parser gaps it surfaced
2. borrowing its shared artifact/MCP/reconstruction patterns where they fit
3. keeping our stronger documentation discipline and confidence grading

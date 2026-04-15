# Open Questions

Access date: 2026-04-15

## High Priority

- Kiro internal store: the public Kiro docs confirm per-directory auto-saved sessions, UUID session IDs, JSON export/import, and resume behavior, but not the internal `workspace-sessions/*.json` schema assumed by `src/parsers/kiro.ts`. A live install or first-party desktop code would close this gap.
- Antigravity protobuf schema: current local installs store binary `.pb` files under `.gemini/antigravity/conversations/`, but I did not find a first-party schema for those files. The current JSONL parser is almost certainly stale.
- Cursor transcript completeness: sampled local `agent-transcripts/*.jsonl` files were text-only, while the parser expects optional Anthropic tool/usage passthrough. A larger sample set or first-party schema doc is needed to know when tool-use blocks are actually present.

## Medium Priority

- Kilo Code product split: first-party issue evidence confirms legacy extension task storage in `ui_messages.json`, while the official repo contains a newer `kilo.db`/OpenCode-style persistence layer. It is still unclear which channel(s) `continues` should prioritize.
- Kimi current history source: official code still treats `context.jsonl` as the history file, but sampled local sessions had empty `context.jsonl` files and useful `wire.jsonl` chronology. This may be a bug, a migration edge case, or a workflow-specific behavior.
- Copilot per-session `session.db`: some local session-state directories had `session.db` but no `events.jsonl`. GitHub’s public docs emphasize `events.jsonl` plus the global `session-store.db`, but do not explain the per-session `session.db` variant.

## Lower Priority

- Claude compact-summary semantics: raw `isCompactSummary` records are real, but more evidence would help separate auto-compact summaries from manual `/compact` flows in downstream handoff logic.
- Amp on-disk assistant examples: the official plugin API documents assistant block types, but I did not find a populated local thread file with both user and assistant turns to validate the exact persisted JSON shape.

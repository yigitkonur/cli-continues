# Codex CLI

Accessed: 2026-04-15

## Documented Fact

- Default root: `CODEX_HOME`, defaulting to `~/.codex`
- Session rollout path:
  - `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<thread-id>.jsonl`
- Archived rollout path:
  - `~/.codex/archived-sessions/...`
- Global message history path:
  - `~/.codex/history.jsonl`
- Other local state:
  - `~/.codex/log/`
  - SQLite-backed state under `sqlite_home`
  - `~/.codex/auth.json` when file-based auth is enabled
- Formats:
  - Rollouts: JSONL
  - Message history: append-only JSONL
  - State DB: SQLite
- Session-ID location:
  - Rollout filename embeds the thread ID
  - The first `SessionMeta` line also carries the canonical thread/session ID
- Append/update behavior:
  - New rollouts are created lazily
  - Resumed sessions reopen the rollout file in append mode
  - `history.jsonl` is append-only, capped by `history.max_bytes`, and compacted by dropping oldest records when needed

## Observed Example

- OpenAI’s rollout recorder example path uses a concrete file like `~/.codex/sessions/rollout-2025-05-07T17-24-21-...jsonl`, while current code now date-partitions rollouts under year/month/day directories before writing the same filename pattern.

## Inference

- The date-partitioned filesystem rollout plus SQLite repair/listing means Codex’s operational source of truth is mixed: rollouts remain the resume substrate, while SQLite accelerates listing/search.

## Comparison Against `continues`

- Registry: `src/parsers/registry.ts` is directionally correct about `~/.codex/sessions/` and `CODEX_HOME`, but it compresses multiple stores into one help string.
- Parser: `src/parsers/codex.ts` correctly looks for `rollout-*.jsonl` recursively and derives the session ID from the filename.
- Gaps:
  - No documentation in `continues` about date partitioning.
  - No modeling of `history.jsonl`, archived sessions, logs, or SQLite-backed state.

## Direct Access Recipe

- Rollout transcript: `~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl`
- Global prompt history: `~/.codex/history.jsonl`
- SQLite state root: value of `sqlite_home` in config

## Sources

- Official docs: https://developers.openai.com/codex/config-reference
- Official docs: https://developers.openai.com/codex/config-advanced
- Official repo code: https://github.com/openai/codex


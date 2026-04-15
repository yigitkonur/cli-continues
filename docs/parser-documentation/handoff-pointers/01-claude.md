# Claude

## Documented Facts

- Official Claude Code docs say transcripts live under `~/.claude/projects/<project>/<session>.jsonl`, with large tool output spilled into `projects/<project>/<session>/tool-results/`. If `CLAUDE_CONFIG_DIR` is set, the same layout moves under that directory. They also document `file-history/<session>/` and other sidecar data under `~/.claude/`.

## Observed Example

- `src/parsers/claude.ts` reads UUID-named JSONL files under the `projects/` tree, then derives the sidecar directory by stripping `.jsonl`. It already knows how to inspect `subagents/` and `tool-results/`.
- `src/__tests__/fixtures/index.ts` creates a Claude fixture as newline-delimited JSON objects with `type`, `sessionId`, `cwd`, `gitBranch`, `timestamp`, and `message`.

## Inference

- Claude can support one of the strongest pointer blocks in the product because the raw transcript path, sidecar directory, and record count are all deterministic and cheap to compute.

## Unresolved Uncertainty

- None that block a pointer block. The main caveat is persistence can be disabled by user settings or flags, so absence of transcript data should be treated as a real runtime condition, not parser failure.

## Default-Mode Pointer Block

- `Session`: Claude Code / `<session-id>`
- `Raw transcript`: `<claude-config-dir>/projects/<project>/<session-id>.jsonl`
- `Backend`: JSONL transcript
- `Volume`: `<line-count>` JSONL records
- `Companions`: include `tool-results/` and `subagents/` counts only when non-zero
- `Quick inspect`: `sed -n '1,12p' <session>.jsonl` and `tail -n 12 <session>.jsonl`
- `Deepen`: `ls <session-dir>/tool-results <session-dir>/subagents`

## Full-Mode Pointer Block

- Everything from default mode
- `Sidecars`: explicit paths for `tool-results/`, `subagents/`, and `file-history/<session-id>/` when present
- `Raw cues`: note whether compacted history markers are present
- `Record mix`: counts of `assistant`, `user`, `queue-operation`, and compact-summary records when cheap
- `Focused retrieval`:
  - `rg -n '"type":"queue-operation"|isCompactSummary|tool_result|tool_use' <session>.jsonl`
  - `find <session-dir>/subagents -maxdepth 1 -type f`
  - `find <session-dir>/tool-results -maxdepth 1 -type f -ls`

## Why This Is Feasible

- `continues` already has `session.originalPath`, line counts, subagent parsing, and `tool-results` directory inspection in `src/parsers/claude.ts`.
- The sidecar directory is deterministic: `<session>.jsonl` without the extension.

## Current `continues` Comparison

- Current handoff markdown shows the session file path, but it appears inside the generic overview table and later `Source Data`, not as a top-of-handoff retrieval guide.
- Current presets change truncation and detail volume, but they do not expose the sidecar directories or tell the receiver how to inspect them.

## Sources

- Official docs: https://code.claude.com/docs/en/claude-directory (accessed 2026-04-15)
- Local parser: `src/parsers/claude.ts` (read 2026-04-15)
- Local fixture generator: `src/__tests__/fixtures/index.ts` (read 2026-04-15)

# Claude Code

Accessed: 2026-04-15

## Documented Fact

- Default storage root: `~/.claude/`
- Env-var override: `CLAUDE_CONFIG_DIR` relocates the global `~/.claude` root.
- Session transcript path: `projects/<project>/<session>.jsonl`
- Spillover paths:
  - `projects/<project>/<session>/tool-results/` for large tool outputs
  - `file-history/<session>/` for edit checkpoints
  - `history.jsonl` for prompt-history entries
- Storage format: plaintext JSONL transcripts plus sidecar directories/files.
- Session-ID location: the `<session>` filename segment is the canonical session identifier; transcript lines also carry `sessionId`.
- Persistence controls:
  - `CLAUDE_CODE_SKIP_PROMPT_HISTORY`
  - `--no-session-persistence`
  - Agent SDK `persistSession: false`

## Observed Example

- The official Anthropic issue tracker shows `CLAUDE_CONFIG_DIR` moving the global `.claude` tree while project-local `.claude/settings.local.json` can still be created in a workspace.

## Inference

- The transcript file is append-oriented rather than rewritten wholesale because Anthropic documents it as a full JSONL conversation transcript and separately spills large outputs into `tool-results/`.

## Unresolved Uncertainty

- Anthropic’s public docs do not spell out line-level transcript schemas or the exact threshold that moves a tool result from the main JSONL file into `tool-results/`.

## Comparison Against `continues`

- Registry: `src/parsers/registry.ts` is directionally correct on `~/.claude/projects/` and `CLAUDE_CONFIG_DIR`.
- Parser: `src/parsers/claude.ts` correctly scans UUID-named `.jsonl` transcripts and falls back to the filename for session ID.
- Gap: `continues` does not model `tool-results/`, `file-history/`, or persistence-disable switches, so “full session recovery” is incomplete even when the main transcript parses.

## Direct Access Recipe

- Read transcript head: `~/.claude/projects/<project>/<session>.jsonl`
- Inspect large tool outputs: `~/.claude/projects/<project>/<session>/tool-results/`
- Inspect edit rollback state: `~/.claude/file-history/<session>/`

## Sources

- Official docs: https://code.claude.com/docs/en/claude-directory
- Official issue: https://github.com/anthropics/claude-code/issues/3833


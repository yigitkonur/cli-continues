# Claude Code Message Schema

Access date: 2026-04-15

## Raw Schema

- Documented fact: Claude Code hook payloads expose `session_id` and `transcript_path`, and the docs show `transcript_path` values ending in `.jsonl` under `~/.claude/projects/...`. `SessionStart` differentiates `startup`, `resume`, `clear`, and `compact`. `PreCompact` and `PostCompact` are explicit hook phases.
- Observed example: A sampled local transcript line is a JSON object with top-level fields such as `type`, `timestamp`, `sessionId`, `cwd`, `uuid`, `parentUuid`, and `message`.
- Observed example: Sampled line types included `queue-operation`, `user`, `assistant`, and `attachment`.

## Assistant Messages

- Observed example: Assistant turns use `type: "assistant"` and `message.role: "assistant"`.
- Observed example: `message.content` is block-based. Sampled assistant blocks included `text`, `tool_use`, and `thinking`.
- Observed example: Assistant records also carried `message.model` and `message.usage`.

## User Messages

- Observed example: Human turns use `type: "user"` and `message.role: "user"`.
- Observed example: Tool results also arrive as `type: "user"` lines whose `message.content` contains `tool_result` blocks, with fields like `tool_use_id` and result content.
- Inference: Recent-message reconstruction must distinguish human user turns from tool-result carrier turns.

## Ordering, Boundaries, And Compaction

- Documented fact: The transcript is JSONL, so file order is the primary ordering model.
- Observed example: Each line also carries its own ISO timestamp string.
- Observed example: A sampled compacted-summary record carried `isCompactSummary: true`.
- Documented fact: Claude’s hook lifecycle explicitly models compaction, and `SessionStart` can indicate `compact`.
- Inference: Message boundaries are line-based, but a single logical assistant turn may span multiple adjacent lines: assistant tool-use, user tool-result, then assistant text.

## Direct Access

- Read the transcript directly: `jq -c . ~/.claude/projects/<project>/<session>.jsonl`
- Find compacted summaries: `rg -n '"isCompactSummary":true' ~/.claude/projects`
- Find tool-result carrier user lines: `rg -n '"tool_result"' ~/.claude/projects/<project>/<session>.jsonl`

## Parser Comparison

- `src/parsers/claude.ts` is correct to treat `user` tool-result-only messages differently from human input; the raw schema supports that distinction.
- `src/parsers/claude.ts` also correctly models `queue-operation`, subagent side files, and compact-summary handling as Claude-specific features.
- The parser still flattens assistant blocks into plain text for recent conversation, so assistant tool-use/thinking boundaries are lost in the handoff.
- The current markdown renderer trims after parser-side filtering, which is safer than raw tail slicing but still does not preserve the full assistant/tool/result turn structure.

## Sources

- Anthropic hooks docs: https://docs.anthropic.com/en/docs/claude-code/hooks (accessed 2026-04-15)
- Anthropic costs docs: https://docs.anthropic.com/en/docs/claude-code/costs (accessed 2026-04-15)
- Observed local transcript: `~/.claude/projects/-/b234a1b2-b63f-4be6-84ab-43281cb07adf.jsonl` (accessed 2026-04-15)
- Observed local compact-summary transcript: `~/.claude/projects/-Users-yigitkonur-dev-cli-codex-worker/8fb1ee76-8226-466c-823c-53d1e8292505.jsonl` (accessed 2026-04-15)

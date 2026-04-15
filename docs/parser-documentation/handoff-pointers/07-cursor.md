# Cursor

## Documented Facts

- First-party Cursor forum posts say historical data can remain intact under `.cursor/projects/agent-transcripts` even when the UI cannot load chat history because `state.vscdb` is corrupted.
- In the same forum, Cursor staff said a `.jsonl` transcript/export path dropped `tool_use` data when Cursor moved from `.txt` to `.jsonl`, and likely still omits `tool_result` because of size.

## Observed Example

- `src/parsers/cursor.ts` reads `~/.cursor/projects/<project-slug>/agent-transcripts/<uuid>/<uuid>.jsonl`.
- The parser treats each line as Anthropic-style content blocks and extracts tool summaries from the raw transcript, but there is no current receiver-visible warning about transcript completeness risk.

## Inference

- Cursor’s pointer block should always pair the transcript path with a completeness warning. A receiver should know that local transcript existence is high-confidence, but tool fidelity inside those transcripts is not fully trustworthy.

## Unresolved Uncertainty

- The forum evidence is about `.jsonl` transcript/export behavior, but it is still unclear whether local `agent-transcripts` and exported transcript files have identical completeness guarantees in all releases.

## Default-Mode Pointer Block

- `Session`: Cursor / `<session-id>`
- `Raw transcript`: `~/.cursor/projects/<project-slug>/agent-transcripts/<session-id>/<session-id>.jsonl`
- `Backend`: JSONL transcript
- `Volume`: `<line-count>` rows
- `Completeness`: `tool_use/tool_result fidelity may be incomplete; verify before relying on transcript-only tool history`
- `Quick inspect`: `sed -n '1,12p' <transcript>.jsonl`

## Full-Mode Pointer Block

- Everything from default mode
- `Project slug`: show the derived slug from the transcript path
- `UI index note`: mention Cursor’s `state.vscdb` as the UI/session index state implicated in first-party recovery threads
- `Focused retrieval`:
  - `rg -n '"role":"assistant"|"role":"user"' <transcript>.jsonl`
  - `rg -n 'tool_use|tool_result|Write|Delete|StrReplace' <transcript>.jsonl`
- `Caveat`: tell the receiver to validate tool presence against the raw file, not just `continues` summaries

## Why This Is Feasible

- `continues` already has the transcript path and line count.
- The warning is static and evidence-backed; it does not require extra runtime cost.

## Current `continues` Comparison

- Current handoff output implies a cleaner raw-tool story than Cursor’s first-party forum evidence supports.
- A top-of-handoff pointer should make the transcript path and the completeness caveat visible before any normalized tool summary.

## Sources

- First-party forum recovery thread: https://forum.cursor.com/t/chat-history-not-loading-after-vs-code-settings-sync-possible-state-inconsistency/150559 (accessed 2026-04-15)
- First-party forum transcript/tool-use thread: https://forum.cursor.com/t/jsonl-format-should-fully-record-the-tool-use-information/154777/4 (accessed 2026-04-15)
- Local parser: `src/parsers/cursor.ts` (read 2026-04-15)

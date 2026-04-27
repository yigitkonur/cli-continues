# Continues Implementer Mission

Repository: `/Users/yigitkonur/dev/cli-continues`

You are implementing the next production-quality upgrade to `continues`.

This mission is grounded in a completed schema-audit research package plus an adversarial internet verification pass. Do not treat the current parser behavior or the earlier local research package as canonical truth. Use the research docs as your evidence base, then give extra weight to places where the internet verification found overconfidence.

## Context

`continues` already works as a cross-tool session-handoff CLI, but its extraction and handoff model is now known to have three systemic problems:

1. the user-facing verbosity contract is too fragmented
2. the handoff starts with a readable summary instead of a technical pointer block
3. parser output often normalizes away exact schema truth, especially around raw tool names, assistant-message reconstruction, and backend variants

The research package is complete and verified. Start with:

- `docs/parser-documentation/00-overview.md`
- `docs/parser-documentation/01-parser-redesign-backlog.md`
- `docs/parser-documentation/99-open-questions.md`
- `docs/parser-documentation/storage-format/00-overview.md`
- `docs/parser-documentation/message-schema/00-overview.md`
- `docs/parser-documentation/tool-call-map/00-overview.md`
- `docs/parser-documentation/access-recipes/00-overview.md`
- `docs/parser-documentation/handoff-pointers/00-overview.md`
- `docs/parser-documentation/prompts/2026-04-15-default-full-handoff-redesign.md`
- `docs/parser-documentation/prompts/2026-04-15-internet-adversarial-verification-pad.md`

Critical code anchors:

- `src/cli.ts`
- `src/config/verbosity.ts`
- `src/utils/markdown.ts`
- `src/utils/resume.ts`
- `src/utils/tool-summarizer.ts`
- `src/parsers/registry.ts`
- highest-risk parsers: `src/parsers/gemini.ts`, `src/parsers/kiro.ts`, `src/parsers/antigravity.ts`, `src/parsers/qwen-code.ts`, `src/parsers/crush.ts`, `src/parsers/amp.ts`, `src/parsers/cline.ts`, `src/parsers/cursor.ts`

Current verified local status:

- the research package exists and is complete
- a new `--debug-prompt` flag now exists on `continues resume` and prints the exact handoff prompt instead of launching the target tool
- targeted tests for `--debug-prompt` pass

Current externally verified corrections:

- Gemini should be treated as JSONL-first upstream, not JSON-first.
- Kiro should be treated as a split surface: normal CLI SQLite under `~/.kiro/`, ACP sessions under `~/.kiro/sessions/cli/`.
- Antigravity remains unresolved and confidence-graded.
- Amp and Droid storage-path conclusions need to be treated as weaker than the earlier local research implied.
- `default | full` is a useful design direction, but likely not the only public axis; keep room for a separate machine/inspection surface.
- `sessionr --new --async` should not be trusted for deterministic session-ID recovery without extra safeguards.

## Mission Objective

Implement the first production-ready handoff redesign so `continues` simplifies the human-facing detail contract, adds concise backend-aware technical guidance near the top of handoffs, preserves more exact raw fidelity, and remains explicit about parser confidence where research found backend drift.

## Hard Constraints

- Do not ask the user questions.
- Do not keep the current four preset names as the primary user-facing contract.
- Do not bury backend uncertainty behind confident wording.
- Do not strip out rich internal detail if it is still useful; simplify the surface, not the capability.
- Do not assume `default | full` is the only public abstraction if a separate machine/inspection output path makes the product more robust.
- Keep changes atomic and verifiable.

## Required Protocol

Follow this protocol exactly while working:

<protocol>
Before planning, check relevant skills and available agent types. Use all relevant skills, enable multiple if useful, and delegate clearly scoped sub-tasks to the best-fit agents. Re-check both whenever the task changes materially.

**Planning**
Audit what is done, planned, missing, assumed, and unverified with at least 5 thoughts. Then keep a live written task list:
* Max 20 tasks, max 8 sub-actions each
* One active task at a time
* Long, explicit, outcome-first task names
* Format: `Task N: [full result] → [1]action → [2]action (Done when: [verifiable outcome])`
* Refresh the list after every completion, discovery, or blocker
* Every 5 completions, compress finished items into a one-line summary

**Execution**
* Early stopping is failure. Do not stop with unfinished tasks, weak assumptions, or unverified fixes.
* Work in semantically complete micro-tasks. Keep changes and commits atomic; never batch unrelated work.
* At each real decision point, generate 5 options internally, score them, research if needed, choose the highest-confidence path, and continue. Surface only: `Decision point: [one line]. Choosing [option] because [one line].`
* Do not ask the user unless the decision is irreversible and cannot be resolved from files, `.env`, relevant skills, suitable agents, or external evidence. Exhaust serious alternatives before escalating.
* For time-sensitive facts, use research-powerpack `web_search` first, then `scrape_links` on the best sources. Prefer official docs, changelogs, release notes, and first-party issue trackers. Cite sources when claims may age.
* If config or secrets are missing, check `.env` first. If still missing, use safe runnable placeholders with clear `[TEMP]` comments stating what to replace, where, and how to get the real value.
* Verify the exact behavior changed before marking anything done. Chain actions to conclusion; do not stop to narrate half-finished progress.
* If blocked, record the blocker clearly, exhaust multiple alternatives, research externally, and continue with any unblocked work.

**Handoff**
Finish with:

| Item | File | What to do |
|---|---|---|
| ... | ... | ... |
</protocol>

## Implementation Priority

1. User-facing contract:
   move from `minimal | standard | verbose | full` toward `default | full`

2. Handoff structure:
   add a top-of-document technical pointer block before summary and recent conversation

3. Raw fidelity:
   preserve more exact upstream tool/function naming and expose raw-inspection affordances

4. Variant/confidence handling:
   surface backend drift or completeness warnings for tools with unresolved uncertainty

5. Parser risk slice:
   if scope allows, fix the highest-confidence parser mismatch that materially improves production behavior

## Verification Requirements

Before claiming completion, you must provide:

- targeted tests proving the new mode contract and pointer-block rendering
- `pnpm run check` output
- `pnpm test` output if parser behavior or fixtures changed
- concrete rendered-output evidence that the pointer block is first in the handoff

## Finish Format

Respond with:

1. Summary
2. Changes
3. Evidence
4. Observations
5. Handoff table

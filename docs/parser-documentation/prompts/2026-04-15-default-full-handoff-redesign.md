# Default/Full Handoff Redesign

## Context Block

This mission exists because the schema-audit research for `continues` is now complete enough to support a real redesign of the handoff layer. The current product works, but the handoff still starts with a generic summary instead of navigational raw-storage guidance, the top-level verbosity contract is still exposed as `minimal | standard | verbose | full`, exact upstream tool/function names are normalized away too early, and recent-message extraction is not consistently grounded in raw storage truth. The research set in `docs/parser-documentation/` established that several parsers are materially stale or variant-sensitive, especially `gemini`, `kiro`, `antigravity`, `qwen-code`, `crush`, `amp`, `kilo-code`, and parts of `cursor`.

What happened before: a multi-context research wave produced evidence-backed docs for storage format, message schema, tool-call fidelity, direct-access recipes, and handoff-pointer design across all 16 canonical tools. A later adversarial internet verification pass found that some local conclusions were too strong. In particular:

- Gemini is clearly JSONL-first upstream now.
- Kiro is clearly not just the old JSON path; current docs split normal CLI SQLite storage from ACP `.json` + `.jsonl` sessions.
- Antigravity remains under-documented and should stay confidence-graded.
- Amp and Droid storage-path claims need to be downgraded where first-party docs are weaker or point elsewhere.
- `default | full` is a promising simplification, but not necessarily the only public axis; comparable CLIs often separate human-readable views from machine/inspection outputs.

The master synthesis is in `docs/parser-documentation/00-overview.md`, the prioritized work list is in `docs/parser-documentation/01-parser-redesign-backlog.md`, and the unresolved issues are in `docs/parser-documentation/99-open-questions.md`. You are not starting from vague product intuition. You are starting from a research package that already says what is wrong and what the next contract should be, plus an adversarial pass that says where that package overreached.

What you need to know right now: the current user-facing contract is shaped in `src/config/verbosity.ts` and surfaced in `src/cli.ts`; the current handoff markdown structure is in `src/utils/markdown.ts`; tool summarization is in `src/utils/tool-summarizer.ts`; parser-specific extraction lives in `src/parsers/*.ts`; and adapter metadata lives in `src/parsers/registry.ts`. The redesign goal is not cosmetic. It is to make handoffs navigable, technically grounded, and honest about raw fidelity.

Start with these files:

- `docs/parser-documentation/00-overview.md` for the integrated findings
- `docs/parser-documentation/01-parser-redesign-backlog.md` for implementation order
- `docs/parser-documentation/99-open-questions.md` for unresolved blockers that must be surfaced rather than ignored
- `src/config/verbosity.ts` for the current preset model
- `src/utils/markdown.ts` for the current handoff structure
- `src/utils/tool-summarizer.ts` for current fidelity loss points
- `src/parsers/registry.ts` and the highest-risk parsers for current backend assumptions

After reading this context, your mental model should be: the next version of `continues` needs earlier raw-storage orientation, better raw-schema fidelity, and explicit confidence/variant handling for tools with storage drift. It may still end up with `default | full`, but that should be implemented as a careful human-facing simplification rather than a dogmatic one-dimensional output model.

## Mission Objective

Implement the first production-ready version of the handoff redesign so `continues` simplifies its human-facing detail model, adds concise backend-aware technical guidance near the top of the handoff, preserves more exact tool/message fidelity, and remains honest about parser confidence where upstream storage reality is uncertain.

Hard constraints:

- Do not keep the current four-preset model as the primary user-facing contract.
- Do not remove the ability to render rich detail internally if it is still useful.
- Do not present stale storage assumptions as canonical truth.
- Do not assume `default | full` is the only possible public abstraction if the implementation clearly benefits from a separate machine/inspection axis.
- Preserve backward safety where practical, but prioritize correctness and navigational value over compatibility theater.
- Any unresolved tool/backend uncertainty must be surfaced explicitly in the product output or code comments, not buried.

Known risks and tradeoffs:

- Some parser families may need incremental adaptation rather than full correction in one pass.
- A perfect raw-fidelity model for every tool may not be achievable immediately, but the handoff can still improve materially if confidence and variants are handled correctly.
- The most dangerous failure is pretending the parser knows more than it actually knows.

Priority signal: correctness of the new contract beats minimal diff size, and navigational usefulness beats legacy wording continuity.

You own this mission end-to-end. Explore freely, trust your judgment, adapt your approach as you learn more. The destination is fixed; the path is yours.

## Research & Tool Guidance

This is a high-ambiguity, unfamiliar-codebase mission with external evidence already gathered. Before changing code, explicitly state your interpretation of the redesign scope, list the highest-risk parser/backend mismatches that affect the implementation, and explain what you will solve now versus what you will surface as deferred uncertainty. Use the research docs as evidence, not decoration.

Trace the full handoff pipeline from CLI flags through config selection, parser extraction, markdown generation, and resume launching. Use the research package to define:

- what the simplified default human-facing view must contain
- what the deeper/debug/full view must add
- how the pointer block should be built per tool/backend family
- where exact upstream tool names should survive
- how confidence/variant warnings should be surfaced

Extract what matters from the research docs:

- highest-risk parser mismatches
- pointer block fields
- tool families that need variant-aware handling
- retrieval recipes that are safe enough to expose
- places where the adversarial verification says the local research was too strong

Use as many local code reads and tests as needed. There is no minimum and no arbitrary cap. Thoroughness is expected.

## Definition Of Done

- The CLI replaces the four-preset user-facing contract with a simpler human-facing detail model, and any deeper machine/inspection surface is explicit rather than accidental.
- Generated handoff markdown includes concise technical guidance near the top before or alongside the main summary, without burying the human-readable continuation context.
- The pointer block includes raw-source orientation, backend format, session handle, and at least one quick-inspect recipe when a reliable raw source exists.
- The implementation surfaces parser-confidence or backend-variant warnings for tools where the research package identified unresolved drift.
- At least one existing parser path preserves more exact upstream tool/function naming than the current summarized-only output.
- Tests covering the new top-level mode contract and pointer-block rendering pass.
- `pnpm run check` exits successfully.
- If parser changes touch fixtures or parser behavior, `pnpm test` exits successfully.

You must achieve 100% of every criterion above before reporting completion.
Partial completion = not complete. Do not report back until every item is fully satisfied.
If you believe a criterion is impossible to meet, report that finding with evidence — do not silently skip it.

## Verification Requirements

Before reporting completion, verify the CLI-facing mode contract, show sample rendered markdown proving the pointer block is first, run the relevant tests, and include command output demonstrating the DoD criteria.

## Failure Protocol

If you cannot complete this mission, report:

1. what you attempted
2. what you discovered
3. why completion was blocked
4. what you would try next

Never silently skip a parser, a mode contract change, or a verification step.

## Handback Format

When you complete this mission, respond with:

1. Summary
2. Changes
3. Evidence
4. Observations

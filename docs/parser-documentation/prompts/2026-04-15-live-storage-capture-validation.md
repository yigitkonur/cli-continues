# Live Storage Capture Validation

## Context Block

This mission exists because the schema-audit research package for `continues` found several tools whose current parser assumptions are still too uncertain to treat as settled. The strongest unresolved tools are `kiro`, `antigravity`, `cursor`, `amp`, `droid`, and `kilo-code`, with additional format-version uncertainty around `gemini` and `qwen-code`. The current docs in `docs/parser-documentation/` already separate fact from inference, but the next step requires direct local captures from fresh or active installs.

What happened before: a broad research pass gathered first-party documentation, repo evidence, issue/forum statements, and local observations where available. That was enough to identify likely drift and define redesign direction, but not enough to declare canonical raw storage for every uncertain tool. This mission is the validation pass that turns likely drift into verified local evidence.

What you need to know right now: the unresolved questions are consolidated in `docs/parser-documentation/99-open-questions.md`. Tool-specific open questions also live in each context folder’s `99-open-questions.md`. The parser assumptions to compare against are in `src/parsers/*.ts` and `src/parsers/registry.ts`.

Start with these files:

- `docs/parser-documentation/99-open-questions.md`
- `docs/parser-documentation/storage-format/99-open-questions.md`
- `docs/parser-documentation/message-schema/99-open-questions.md`
- `docs/parser-documentation/tool-call-map/99-open-questions.md`
- `src/parsers/registry.ts`
- the parser files for the tools you validate

After reading this context, your mental model should be: this is not generic exploratory research. It is a targeted local-evidence mission designed to confirm or correct the most uncertain parser assumptions still blocking the redesign.

## Mission Objective

Collect and document live local storage captures for the highest-uncertainty tools so the remaining parser/backend questions in `continues` are resolved with direct evidence rather than inference.

Hard constraints:

- Do not modify any source session stores.
- Do not infer a canonical store when direct capture contradicts current assumptions.
- Capture enough lifecycle variation to reveal storage behavior changes, not just a static file tree.
- Clearly separate observed local evidence from any upstream or documented evidence you cite.

Known risks and tradeoffs:

- Some tools may not be installed or may not have active sessions available.
- Even partial captures are useful if they conclusively disprove a current parser assumption.
- The mission can fail usefully if it returns structured evidence of missing local prerequisites.

Priority signal: direct local evidence beats elegance, and disproving a stale assumption is as valuable as confirming a correct one.

You own this mission end-to-end. Explore freely, trust your judgment, adapt your approach as you learn more. The destination is fixed; the path is yours.

## Research & Tool Guidance

Frame the problem before acting: state which uncertain tools you can validate on this machine, which ones you cannot, and what evidence would count as decisive for each. For each tool you can validate, inspect the raw storage tree after meaningful lifecycle moments:

1. first prompt
2. first assistant response
3. first tool call
4. resume
5. compact/rewind if supported
6. archive/export if supported

For each capture, extract:

- raw file tree
- primary transcript or DB path
- sidecar or auxiliary artifacts
- session ID location
- assistant-message carrier
- tool-call carrier
- whether the current parser assumption in this repo is correct, partially correct, or wrong

Use as many local inspections as needed. No minimum. Depth is expected where the tool is available.

## Definition Of Done

- Every tool you were able to validate has a documented local capture record with lifecycle-specific observations.
- Every validated tool includes an explicit comparison against the current parser/registry assumption.
- Every tool you could not validate has an evidence-backed explanation of why validation was not possible.
- The final output clearly identifies which parser assumptions are now proven correct, proven wrong, or still unresolved.

You must achieve 100% of every criterion above before reporting completion.
Partial completion = not complete. Do not report back until every item is fully satisfied.
If you believe a criterion is impossible to meet, report that finding with evidence — do not silently skip it.

## Verification Requirements

Before reporting completion, show the validated tool list, the unavailable-tool list, and the key local paths or DB artifacts observed for each successful capture.

## Failure Protocol

If you cannot complete this mission, report:

1. what you attempted
2. what you discovered
3. why completion was blocked
4. what you would try next

Never silently skip a validation target or a parser-comparison step.

## Handback Format

When you complete this mission, respond with:

1. Summary
2. Changes
3. Evidence
4. Observations

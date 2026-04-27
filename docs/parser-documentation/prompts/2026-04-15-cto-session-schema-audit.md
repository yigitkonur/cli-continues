# CTO Session Schema Audit

## Context Block

This mission exists because the handoff quality in `continues` is constrained by inconsistent parser behavior and insufficient technical orientation at session start. The product works, but the extraction layer is uneven: verbosity is currently expressed through four presets in `src/config/verbosity.ts`, the shared markdown renderer in `src/utils/markdown.ts` does not begin with a deep-access technical pointer block, tool activity is grouped and normalized in ways that can hide exact function names, and message trimming/extraction varies across parsers in `src/parsers/*.ts`. The CTO flagged a schema-accuracy concern without providing a concrete failing example. Treat that as a high-signal warning, not an empty complaint. The real task is to independently verify the upstream session-storage realities of every supported coding agent so the parser redesign can be driven by evidence instead of guesswork.

What happened before: the current codebase already reverse-engineers and normalizes sessions from many tools, but it optimizes for a readable handoff rather than a navigable technical briefing. The resulting handoff is useful for continuity, but weaker than it should be for deep follow-up work. A future redesign is expected to move toward two clear modes, default and full, while also exposing raw-storage orientation: where the session lives, what the record shape looks like, how assistant messages appear, how tool calls are encoded, and how an agent can retrieve deeper slices of evidence on demand. This mission is the evidence-gathering phase for that redesign.

What you need to know right now: the canonical tool list is defined in `src/types/tool-names.ts`; adapter-level behavior and storage-path expectations live in `src/parsers/registry.ts`; the current verbosity model lives in `src/config/verbosity.ts`; the handoff shape lives in `src/utils/markdown.ts`; tool summarization lives in `src/utils/tool-summarizer.ts`; and individual parser assumptions live in `src/parsers/*.ts`. You are not validating only the current implementation. You are validating reality outside the repo and then comparing that reality to the implementation. The product currently supports Claude, Codex, Copilot, Gemini, OpenCode, Droid, Cursor, Amp, Kiro, Crush, Cline, Roo Code, Kilo Code, Antigravity, Kimi, and Qwen Code.

Start with these files:

- `src/types/tool-names.ts` to confirm the full tool surface that must be researched.
- `src/parsers/registry.ts` to understand the current storage-path, binary, and adapter assumptions per tool.
- `src/config/verbosity.ts` to see the current preset model that research should help simplify.
- `src/utils/markdown.ts` to understand what the current handoff includes and what it does not.
- `src/parsers/<tool>.ts` for each tool you study, to compare current assumptions against external evidence.

After reading the local code, your mental model should be: this is a cross-tool session-handoff system whose next quality jump depends on authoritative schema knowledge, direct-access recipes, and better handoff orientation. Your job is to produce that authority.

## Mission Objective

Produce evidence-backed parser documentation for the assigned context across all supported tools so the team can redesign session initiation, verbosity reduction, assistant-message inclusion, and tool-call fidelity on top of verified storage schemas instead of parser folklore.

Hard constraints:

- Do not rely on existing parser assumptions as truth.
- Prefer official documentation, first-party repos, release notes, and real observed examples over commentary.
- Explicitly label every uncertain claim as inference or unresolved.
- Write only inside your assigned context folder under `docs/parser-documentation/`.
- Preserve exact upstream tool/function names when documenting tool-call behavior.

Known risks and tradeoffs:

- Some tools have sparse public schema documentation, so you may need to combine official sources, issue trackers, and real-world examples.
- A polished summary without retrieval mechanics is insufficient; this work must expose how deeper inspection would actually happen.
- A broad but shallow catalog is less valuable than fewer, high-confidence documents. Use the document ceiling as permission for depth, not as a quota.

Priority signal: source accuracy beats speed, and retrieval usefulness beats stylistic polish.

You own this mission end-to-end. Explore freely, trust your judgment, adapt your approach as you learn more. The destination is fixed; the path is yours.

## Research & Tool Guidance

This is a high-ambiguity, externally dependent mission. Frame before acting: state your interpretation of the schema-audit objective, list plausible failure modes in the current product, and revise that framing if evidence contradicts it. Investigate each tool’s current storage path, override env vars, file or database format, session-id conventions, message representation, assistant-message representation, tool-call representation, and any publicly observable examples. Extract what matters for downstream parser design: top-level object or line structure, where tool results live, how edits/writes/deletes are encoded, whether the data source is append-only, and how a later agent could directly retrieve slices of deeper detail.

Search broadly at first, then narrow to authoritative sources. Use as many search angles as needed; there is no minimum and no arbitrary limit. You may create up to 100 markdown documents across the full research wave if the evidence justifies it, but that is a ceiling, not a target.

For each tool document, extract:

- authoritative storage location details
- format details: JSONL, JSON, YAML, SQLite, or mixed
- assistant-message structure
- tool-call structure with exact tool names preserved
- session-id and message-index semantics where available
- direct-access recipes: file reads, JSON filters, SQL queries, or traversal tips
- gaps between reality and the current parser assumptions
- concrete recommendations for what a handoff “technical pointer block” should expose at the top

## Definition Of Done

- A markdown document exists in the assigned context folder for every supported tool relevant to this repo’s canonical tool list, unless you provide evidence that documentation is impossible for a specific tool.
- Every tool document distinguishes documented fact, observed example, inference, and unresolved uncertainty.
- Every tool document includes a direct-access section explaining how deeper data could be retrieved from the raw source.
- Every tool document includes at least one comparison point against the current local parser or registry assumptions.
- Every source-sensitive claim includes a concrete source link and access date.
- An overview file exists in the assigned context folder summarizing the strongest findings, the highest-risk parser mismatches, and the most valuable redesign implications for `continues`.

You must achieve 100% of every criterion above before reporting completion.
Partial completion = not complete. Do not report back until every item is fully satisfied.
If you believe a criterion is impossible to meet, report that finding with evidence — do not silently skip it.

## Verification Requirements

Before reporting completion, verify that every expected document exists in the assigned folder, confirm that every document includes the required evidence sections, and demonstrate the file list you created. In your handback, include the exact file paths written and a concise evidence summary for the hardest-to-verify tools.

## Failure Protocol

If you cannot complete this mission, report:

1. what you attempted
2. what you discovered
3. why completion was blocked
4. what you would investigate next

Never silently skip a tool, a document, or a verification step.

## Handback Format

When you complete this mission, respond with:

1. Summary
2. Changes
3. Evidence
4. Observations

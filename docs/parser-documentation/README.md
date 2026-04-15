# Parser Documentation Research

This directory is the evidence base for schema accuracy work in `continues`.

The immediate driver is a parser-quality problem:

- session extraction is inconsistent across tools
- verbosity reduction is too open-ended at the top level
- the handoff lacks a concise technical pointer block for deeper inspection
- tool activity often becomes normalized in ways that hide the exact original function names
- assistant-message coverage needs independent validation per tool

The goal of this research set is to give future parser and handoff work a hard evidence base instead of assumptions.

## Top-Level Entry Points

Start here if you need the integrated picture rather than a single context:

- `docs/parser-documentation/00-overview.md`
- `docs/parser-documentation/01-parser-redesign-backlog.md`
- `docs/parser-documentation/99-open-questions.md`

If you need mission-driven follow-up work, start here:

- `docs/parser-documentation/prompts/2026-04-15-cto-session-schema-audit.md`
- `docs/parser-documentation/prompts/2026-04-15-default-full-handoff-redesign.md`
- `docs/parser-documentation/prompts/2026-04-15-live-storage-capture-validation.md`

## Output Layout

Research outputs belong under:

- `docs/parser-documentation/storage-format/`
- `docs/parser-documentation/message-schema/`
- `docs/parser-documentation/tool-call-map/`
- `docs/parser-documentation/access-recipes/`
- `docs/parser-documentation/handoff-pointers/`
- `docs/parser-documentation/prompts/`

`[context]` is the folder name above. Treat it as a variable-like placeholder in prompt language and mission docs.

Within each context folder, documents should follow:

- `01-claude.md`
- `02-codex.md`
- `03-copilot.md`
- `04-gemini.md`
- `05-opencode.md`
- `06-droid.md`
- `07-cursor.md`
- `08-amp.md`
- `09-kiro.md`
- `10-crush.md`
- `11-cline.md`
- `12-roo-code.md`
- `13-kilo-code.md`
- `14-antigravity.md`
- `15-kimi.md`
- `16-qwen-code.md`

If a context needs an overview or synthesis file, reserve:

- `00-overview.md`
- `99-open-questions.md`

## Research Standard

Every tool document should be evidence-backed and should explicitly distinguish:

- documented fact
- observed example
- inference
- unresolved uncertainty

When possible, include:

- storage path and env-var overrides
- file/database format
- session-id semantics
- how assistant messages are represented
- how tool calls are represented
- how to retrieve deeper data directly
- how this should inform handoff pointer design

## Document Ceiling

The research wave may create up to 100 markdown documents here if the evidence justifies it. That is a ceiling, not a target.

## Current Code Anchors

Start with these files when grounding the research against the product:

- `src/types/tool-names.ts`
- `src/parsers/registry.ts`
- `src/config/verbosity.ts`
- `src/utils/markdown.ts`
- `src/utils/tool-summarizer.ts`
- `src/parsers/*.ts`

The main mission brief for the schema audit lives in `docs/parser-documentation/prompts/2026-04-15-cto-session-schema-audit.md`.

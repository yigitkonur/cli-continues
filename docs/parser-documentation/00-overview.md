# Parser Documentation Master Overview

Access date: 2026-04-15

This directory is now a complete parser-research package for `continues`. The five context folders cover storage format, message schema, tool-call fidelity, direct-access recipes, and handoff-pointer design across all 16 canonical tools defined in `src/types/tool-names.ts`.

## What The Research Now Establishes

The current product problem is not that `continues` fails to read sessions at all. The deeper issue is that the parser layer mixes three concerns that need to be separated:

1. schema truth
2. readability-oriented summarization
3. handoff navigation

The current codebase is strongest at summarization. It is weaker at surfacing raw-storage truth and weaker still at showing the receiving agent how to go deeper.

Across the five contexts, the strongest cross-cutting finding is consistent:

- the current four-preset top-level model in `src/config/verbosity.ts` is the wrong user-facing abstraction
- the handoff needs a top-of-document technical pointer block
- exact upstream tool/function names should survive the extraction pipeline
- assistant-message reconstruction needs to be treated as a parser problem, not a markdown-rendering problem
- several tool adapters are materially stale versus current upstream storage reality

## Highest-Risk Drift Versus Current Code

These are the most urgent mismatches repeatedly confirmed across contexts:

| Tool | Main drift | Why it matters |
| --- | --- | --- |
| Gemini | Current upstream code writes JSONL append logs, while `src/parsers/gemini.ts` still targets older JSON session objects. | Discovery, message reconstruction, tool-call recovery, and pointer design are all at risk. |
| Kiro | Public docs now describe SQLite-backed session storage under `~/.kiro/`, while `src/parsers/kiro.ts` targets legacy JSON under app-support paths. | The parser may be aimed at the wrong product surface or a stale backend. |
| Antigravity | Current parser targets `code_tracker` records, while current evidence points toward other conversation stores and/or tracker formats. | Session discovery and transcript fidelity are highly provisional. |
| Qwen Code | Current official repo/runtime evidence points to different runtime roots than the parser assumes. | `continues` may miss sessions entirely on current installs. |
| Crush | Current parser assumes a global DB path, but current evidence points to project-local `.crush/crush.db`. | Discovery and session selection can be wrong. |
| Amp | Current parser assumptions about thread storage are weakly documented and likely incomplete. | Pointer design and reliability are low-confidence. |
| Kilo Code | Evidence conflicts between legacy VS Code `ui_messages.json` task storage and newer DB-backed/OpenCode-style backends. | The current parser may be tied to a legacy branch only. |
| Cursor | Transcript fidelity is intentionally partial in some first-party statements. | Any handoff should warn about transcript completeness limits. |

## Strongest Product-Level Conclusions

### 1. Simplify the user-facing contract, but do not collapse every concern into one toggle

The user-facing problem is not “how many samples should I see.” It is “can I continue immediately, and can I go deeper when I need to.” The local research strongly supported a two-mode design, but the adversarial internet verification found that major CLIs more often separate:

- a human-readable session/transcript surface
- a machine-readable or inspection-oriented output surface
- explicit session/checkpoint/raw inspection commands

So the safer conclusion is:

- keep moving away from `minimal | standard | verbose | full` as the main user-facing contract
- but do not assume `default | full` alone is the final answer
- keep room for a separate machine/inspection axis such as structured output or explicit inspect modes

### 2. Add raw-storage orientation early, but keep it concise and navigational

The local research favored a top-of-document technical pointer block. The external verification supports that only if the block is treated as navigational metadata rather than the universal primary payload.

What should appear early is:

- where the real raw source lives
- what backend it uses
- what session handle is canonical
- how to inspect deeper data immediately
- how trustworthy the parser view is

The pointer block should be short in the default human-facing view and richer in deeper/debug/inspection views. Transcript and summary content should remain first-class, not demoted into a secondary concern for every user.

### 3. Preserve raw fidelity alongside summarized categories

`SummaryCollector` and the grouped markdown sections are useful, but they should not be the only truth carried forward. The next redesign should preserve:

- exact upstream tool/function names
- argument carrier location
- result carrier location
- raw-fidelity warning when outputs are omitted or transcript completeness is partial

The external verification also found a useful refinement:

- exact upstream names should survive in raw/debug/full views
- normalized labels can still remain in the default human summary where they improve readability

### 4. Treat assistant-message reconstruction as tool-specific

Recent-message trimming is unsafe when it assumes one uniform turn model. The research repeatedly showed that assistant output may be split across:

- assistant text records
- assistant tool-call records
- user tool-result carrier records
- append-log mutations or rewinds
- structured part tables in SQLite

The redesign needs tool-specific reconstruction before truncation.

## What Is Now Complete

- `storage-format/`: verified or challenged current storage-root assumptions
- `message-schema/`: documented assistant-message and chronology models
- `tool-call-map/`: mapped exact tool-call encoding and fidelity losses
- `access-recipes/`: documented how to inspect deeper raw data directly
- `handoff-pointers/`: translated evidence into default/full pointer-block recommendations
- `prompts/2026-04-15-cto-session-schema-audit.md`: research mission prompt

## What Still Needs To Happen

- implement the redesign in code
- validate unresolved tools from live local captures
- update parser help text and registry metadata to stop presenting legacy paths as canonical

Use `01-parser-redesign-backlog.md` for implementation order and `99-open-questions.md` for unresolved validation targets.

# Open issues in the Gemini parser comparison

**Scope:** Open questions that matter for a future Gemini parser rewrite or for tightening the Gemini docs in this repo.
**Last updated:** 2026-04-15
**Confidence:** Medium

## 1. What should the directory component under `~/.gemini/tmp/` be called?

**Answer:** Still unresolved.

## Evidence

- First-party session docs say sessions live at `~/.gemini/tmp/<project_hash>/chats/`.
- First-party storage code now initializes a `ProjectRegistry`, stores mappings in `~/.gemini/projects.json`, and uses `getShortId(projectRoot)` for temp/history directory naming.
- First-party `chatRecordingTypes.ts` still persists a `projectHash` field inside conversation metadata.

## Why this matters

- It affects path-discovery logic, docs wording, and whether parsers should rely on hash naming or `projects.json` slug mapping.
- agentlytics already assumes `projects.json` short IDs.
- this repo's docs mix `project-id` and `project-hash` wording.

## 2. Which released Gemini CLI version switched chat recording from legacy `.json` to append-only `.jsonl`?

**Answer:** Not confirmed from a first-party release note in this review.

## Evidence

- Current first-party `chatRecordingService.ts` writes `.jsonl` and migrates legacy `.json`.
- Local docs and local observations still show legacy `.json` sessions existing on disk.
- The first-party Google blog and first-party session docs describe session management, but they do not clearly name the exact version where recorder storage changed format.

## Why this matters

- It determines whether a compatibility parser should dual-read forever, gate by version, or prefer JSONL with legacy fallback.

## 3. How much of Gemini's current JSONL surface should a future parser preserve verbatim?

**Answer:** Open design choice, not a factual gap.

## Evidence

- First-party JSONL includes metadata lines, repeated message IDs, tool-call enrichment, rewinds, and tool result updates.
- agentlytics optimizes for analytics tables and flattens assistant text/tool markers.
- `cli-continues` optimizes for compact handoff markdown and summarized tool activity.

## Why this matters

- A future parser rewrite needs an explicit target:
  - analytics-first
  - handoff-first
  - or a normalized core plus multiple output views

## Sources

- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingService.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingTypes.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/storage.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/config/projectRegistry.ts
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/session-management.md
- https://raw.githubusercontent.com/f/agentlytics/master/editors/gemini.js
- https://raw.githubusercontent.com/f/agentlytics/master/mod.ts
- /Users/yigitkonur/dev/cli-continues/docs/parser-documentation/storage-format/04-gemini.md
- /Users/yigitkonur/dev/cli-continues/docs/parser-documentation/message-schema/04-gemini.md

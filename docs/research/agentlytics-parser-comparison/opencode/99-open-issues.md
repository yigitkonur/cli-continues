# OpenCode comparison open issues

**Scope:** Follow-up questions that remained unresolved after comparing `continues`, agentlytics, and first-party OpenCode sources.
**Last updated:** 2026-04-15
**Confidence:** Medium — these are real gaps, but they do not change the main comparison conclusions.

## Answer

The main storage and tool-call conclusions are already stable. The remaining uncertainty is about ordering semantics and whether agentlytics’ `mod.ts` should be treated as intentionally reduced functionality or a stale OpenCode implementation.

## Evidence

- OpenCode upstream part schema is clear:
  - `packages/opencode/src/session/message-v2.ts` defines structured part types including `tool`, `reasoning`, `step-start`, and `step-finish`.
- OpenCode upstream storage is clear:
  - `packages/opencode/src/storage/db.ts` resolves the active SQLite DB path.
  - `packages/opencode/src/storage/storage.ts` preserves legacy JSON migration logic.
- Part ordering is less clear:
  - `/Users/yigitkonur/dev/cli-continues/src/parsers/opencode.ts` orders SQLite parts by `time_created`.
  - `https://raw.githubusercontent.com/f/agentlytics/master/editors/opencode.js` also orders SQLite parts by `time_created`.
  - OpenCode client sync code sorts parts by `id`, not `time_created`, in `packages/app/src/context/sync.tsx`.
- Agentlytics has two incompatible OpenCode implementations:
  - `editors/opencode.js` understands nested legacy JSON plus SQLite.
  - `mod.ts` only scans flat JSON and skips SQLite.

## Caveats / Negative Signal

- I did not verify the exact OpenCode server/API query that returns message parts to the client, so I cannot prove whether `id` sort or `time_created` sort is canonical.
- I did not find an explicit agentlytics maintainer note describing the intended support level of `mod.ts` for OpenCode.

## Open questions

1. Should OpenCode part ordering in `continues` use `ORDER BY id`, `ORDER BY time_created, id`, or continue using only `time_created`?
2. Should OpenCode tool summaries in `continues` be derived directly from SQLite `part.data` and SQLite `session.summary_*`, instead of legacy JSON session files?
3. Should `continues` honor `OPENCODE_DB` and channel-specific DB filenames to match upstream path resolution?
4. Should agentlytics `mod.ts` be treated as unsupported for OpenCode until it gains SQLite support and nested legacy JSON traversal?

## Sources

- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/db.ts — first-party OpenCode DB path logic — accessed 2026-04-15
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/storage.ts — first-party OpenCode JSON migration logic — accessed 2026-04-15
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/message-v2.ts — first-party OpenCode part schema — accessed 2026-04-15
- https://raw.githubusercontent.com/f/agentlytics/master/editors/opencode.js — agentlytics full OpenCode adapter — accessed 2026-04-15
- https://raw.githubusercontent.com/f/agentlytics/master/mod.ts — agentlytics sandboxed CLI OpenCode scan path — accessed 2026-04-15

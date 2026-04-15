# Open Questions

## Highest-Priority Gaps

### Gemini

- Upstream Gemini CLI code now records append-only JSONL chat logs, but `continues` still parses older single-file JSON sessions.
- Open question: which Gemini variants still emit the older JSON session object in real installs, and how should the parser detect JSON vs JSONL at discovery time without false positives?

### Kiro

- Official docs say Kiro stores sessions in SQLite under `~/.kiro/`, but the current parser still assumes legacy JSON files under `Library/Application Support/Kiro/workspace-sessions/`.
- Open question: what is the exact SQLite filename/schema, and is the JSON layout still produced anywhere outside exports/tests?

### Antigravity

- Current parser targets `~/.gemini/antigravity/code_tracker/` line logs with binary prefixes.
- Upstream Gemini repo evidence in this pass points instead to tracker JSON under per-project temp/session directories.
- Open question: is `code_tracker` still a live product surface, or should the parser be rewritten around the newer tracker layout?

### Cursor

- First-party forum posts confirm local `agent-transcripts` survive UI/index corruption.
- First-party forum posts also confirm at least one `.jsonl` transcript/export path dropped `tool_use` and likely omits `tool_result`.
- Open question: do local `agent-transcripts` and exported transcripts share the same completeness limitations, or are they separate pipelines?

### Factory Droid

- First-party docs clearly expose `session_id` continuation and settings locations.
- They did not, in this pass, publish the on-disk `~/.factory/sessions/.../*.jsonl` layout assumed by the parser.
- Open question: can that raw session store be validated from first-party code/docs or from sanctioned local captures?

### Amp

- First-party docs strongly validate thread IDs, web thread URLs, and `amp threads continue`.
- They did not, in this pass, validate the local JSON thread store under `~/.local/share/amp/threads/` that the parser reads.
- Open question: is that local JSON store stable and official, or merely an observed implementation detail?

### Kilo Code

- The current parser clearly targets the VS Code extension task store (`ui_messages.json` under globalStorage).
- First-party repo search also exposed a newer DB-backed codebase around `kilo.db`.
- Open question: is the extension task store still the canonical storage backend for the product represented by this parser, or is a migration underway?

## Lower-Priority Gaps

### Codex

- Official docs emphasize `CODEX_HOME` and `history.jsonl`, while first-party repo code centers resume on rollout files under `sessions/YYYY/MM/DD/rollout-*.jsonl`.
- Open question: should the redesign surface both, or treat rollout files as the canonical handoff source and history as auxiliary state?

### OpenCode

- Migration issues show JSON and SQLite can coexist.
- Open question: how should the handoff renderer describe installations where stale JSON exists but SQLite is authoritative, without misleading the receiver?

### Crush

- The repo code is clear about tables, but convenient public docs were less available during scraping.
- Open question: do newer docs publish the default DB path and override behavior clearly enough to replace repo-code citations in end-user-facing research?

## Recommended Follow-up Checks

- Capture real local session stores for `gemini`, `kiro`, `antigravity`, `droid`, and `amp`.
- Verify whether `cursor` local `agent-transcripts` preserve tool-use data better than exported transcripts.
- Confirm whether `kilo-code` in this repo should remain grouped with the Cline-family extension store or be split into a new backend family.

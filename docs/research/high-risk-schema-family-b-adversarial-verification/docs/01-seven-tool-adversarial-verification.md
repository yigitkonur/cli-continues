# Which current repo claims about Crush, Amp, Kilo Code, Cursor, Droid, Copilot, and Codex survive first-party adversarial verification?

**Scope:** First-party verification of storage paths, env-var overrides, transcript/tool-call completeness, and backend-drift/fidelity-loss claims for seven high-risk tools; this does not include local runtime captures.
**Last updated:** 2026-04-15
**Confidence:** Medium — 16 independent first-party sources; several tools still lack public on-disk schema docs.

## Answer

Some repo claims hold up well, especially for `cursor`, `copilot`, and most of `codex`. The most important corrections are that `amp` is much less grounded locally than the repo suggests, `droid` now has first-party transcript-path examples that point at `~/.factory/projects/...` rather than the repo’s `~/.factory/sessions/...` assumption, `kilo-code` is not safely classifiable as “legacy VS Code path only” or “SQLite only,” and `crush` should be treated as project-local `.crush/crush.db` by default.

## Summary

- `crush`: the repo is internally inconsistent; current first-party code supports project-local `.crush/crush.db`, not a home-directory default.
- `amp`: the repo’s local `threads/*.json` story is not supported by current first-party docs. Amp explicitly stores conversations on Amp Server; local docs clearly document settings and secrets, not a stable local thread transcript schema.
- `kilo-code`: the repo is right that a new shared-core/OpenCode-style backend exists, but wrong to treat VS Code `ui_messages.json` as merely historical. A first-party issue from November 12, 2025 still shows it active in extension `4.117.0+`.
- `cursor`: the repo’s fidelity-loss warning is supported. First-party staff say local JSONL transcripts include tool-call inputs but intentionally omit tool-call outputs.
- `droid`: the repo’s local observation is plausible, but first-party docs now show hook `transcript_path` examples under `~/.factory/projects/.../*.jsonl`, which weakens confidence in `~/.factory/sessions/...` as the canonical path.
- `copilot`: the repo is directionally right about `events.jsonl`, `session-store.db`, and config overrides, but it overreaches if it implies raw transcript completeness depends on extra undocumented files. GitHub says the per-session files are the complete record and the SQLite store is a subset.
- `codex`: the repo is mostly right on `CODEX_HOME`, local transcripts, `history.jsonl`, and SQLite-backed state, but “rollout is the full audit trail” is weakened by a first-party Codex issue alleging review-mode tool calls do not land in rollout logs.

## Contradicted Claims

1. **`crush` default path is `~/.crush/crush.db`.**
The repo’s older conclusion looks plausible because Crush has global config and cache paths, but current first-party code resolves the workspace data directory locally. `internal/config/load.go` sets `Options.DataDirectory` to the closest ancestor `.crush` or `<workingDir>/.crush`, and `internal/cmd/root.go` initializes the DB connection from that data directory. That directly contradicts any claim that the live default session DB is under the home directory.  
URLs:
- https://github.com/charmbracelet/crush/blob/main/internal/config/load.go
- https://github.com/charmbracelet/crush/blob/main/internal/cmd/root.go

2. **`amp` stores live thread transcripts as a documented local JSON thread store under XDG data.**
This is the weakest repo claim in the set. Current first-party docs explicitly say Amp Server stores conversations in PostgreSQL, and Amp’s security docs describe thread data, retention, and privacy at the server layer. The same docs only clearly document local `~/.local/share/amp/secrets.json`; the manual clearly documents settings under `~/.config/amp/settings.json` or a custom `--settings-file`. That means the repo’s concrete `threads/*.json` local-storage conclusion is not currently supported by first-party material and may be wrong.  
URLs:
- https://ampcode.com/security
- https://ampcode.com/manual

3. **`droid`’s canonical persisted transcript root is `~/.factory/sessions/...`.**
The repo’s claim is based on local observation, so it could still describe one build, but current first-party docs now expose `transcript_path` in hook payloads and show examples under `~/.factory/projects/.../*.jsonl`. That does not prove the repo’s observed `sessions/` tree is impossible, but it does contradict any strong claim that `sessions/` is the current canonical documented root.  
URLs:
- https://docs.factory.ai/reference/hooks-reference

4. **`kilo-code`’s VS Code `ui_messages.json` path is legacy or migration-only now.**
The repo’s newer-backend conclusion has real support, but it goes too far. First-party April 2026 docs say the extension was rebuilt on a shared open-source core used across VS Code, CLI, and Cloud Agents, which supports the “new backend exists” side. But a first-party Kilo issue opened November 12, 2025 for extension `4.117.0+` still shows active writes to `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/.../ui_messages.json` and lock contention on that file. So the safe conclusion is coexistence or transition, not legacy-only.  
URLs:
- https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new
- https://github.com/Kilo-Org/kilocode/issues/3706
- https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/storage/db.ts

5. **`copilot` needs extra undocumented side stores to establish transcript completeness.**
The repo is right that `session-store.db` exists and that undocumented side artifacts may be useful, but GitHub’s current docs are clearer than the repo gives them credit for: every session directory under `~/.copilot/session-state/` contains the complete record for resume, and the SQLite session store is only a subset used for `/chronicle`. That weakens claims that raw fidelity fundamentally depends on `session.db` or other sidecars.  
URLs:
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference

## Supported Claims

1. **`cursor` local transcripts are fidelity-limited and intentionally omit tool outputs.**
The repo’s concern is correct. On April 13, 2026, a Cursor staff reply said the JSONL transcript files include user messages, assistant text responses, and tool-call inputs, but intentionally do not include tool-call outputs because outputs can be very large. That directly supports the repo’s claim that transcript recovery is structurally incomplete for tool-output fidelity.  
URLs:
- https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311

2. **`cursor` transcript files are not enough for full UI recovery.**
The repo argued that transcript files exist but may not be sufficient for full history recovery. A February 6, 2026 Cursor forum thread supports that: the user still had `~/.cursor/projects/.../agent-transcripts`, but recovery advice pointed to restoring `state.vscdb` and `workspaceStorage`. That supports the repo’s “transcripts are real, but not the whole recovery story” claim.  
URLs:
- https://forum.cursor.com/t/lost-all-cursor-settings-and-chat-history-for-all-projects-i-am-working-on/151081
- https://forum.cursor.com/t/where-are-cursor-chats-stored/77295/5

3. **`copilot` uses `~/.copilot/session-state/<id>/events.jsonl`, plus `session-store.db`, with `COPILOT_HOME` and `--config-dir` overrides.**
GitHub’s current docs support all of this directly. They say each session directory stores `events.jsonl` and workspace artifacts, `session-store.db` is a cross-session SQLite database, `COPILOT_HOME` changes the root, and `--config-dir` takes precedence over `COPILOT_HOME`.  
URLs:
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle

4. **`copilot` session data includes tools used and modified files.**
The repo’s broader completeness concern is supported at the product level. GitHub says each local session records prompts, responses, the tools that were used, and details of modified files. What remains undocumented is the exact internal shape of those artifacts, not whether GitHub claims they exist.  
URLs:
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle

5. **`codex` stores local transcripts under `CODEX_HOME`, keeps `history.jsonl`, and has separate SQLite-backed state.**
OpenAI’s docs and repo support this. The Codex docs say sessions live under `~/.codex/sessions/` and that `history.jsonl` is controlled by `history.persistence`; the config reference documents `sqlite_home` for SQLite-backed resumable state; and the Codex repo shows date-partitioned rollout files plus `archived_sessions`.  
URLs:
- https://developers.openai.com/codex/cli/features
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/config-advanced
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/lib.rs

6. **`codex` preserves richer tool-call variants than a simplistic `function_call`/`function_call_output` model.**
The repo’s fidelity warning is supported by first-party code. Codex protocol definitions include `local_shell_call`, `tool_search_call`, `tool_search_output`, `custom_tool_call`, `custom_tool_call_output`, and other response-item types. If the parser only handles a subset, that is a real fidelity gap.  
URLs:
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts

7. **`codex` rollouts may fail to capture some first-party product surfaces completely.**
The repo’s suspicion that rollouts are not always a perfect audit log is strengthened by a first-party issue showing review-mode tool calls missing from rollout logs and resume transcripts. That does not overturn rollout storage itself, but it does weaken “full forensic fidelity” claims.  
URLs:
- https://github.com/openai/codex/issues/4792

8. **`droid` exposes strong first-party evidence for tool-call fidelity, even if the exact persisted path is still shifting.**
Factory’s docs explicitly describe `stream-json` runtime events including `tool_call` and `tool_result`, and hook payloads include `tool_name`, `tool_input`, `tool_response`, `session_id`, and `transcript_path`. That supports the repo’s claim that Droid preserves rich tool-call information; the remaining dispute is storage location and whether runtime and persisted schemas are identical.  
URLs:
- https://docs.factory.ai/cli/droid-exec/overview
- https://docs.factory.ai/reference/hooks-reference

## Still Unresolved

1. **`amp` local on-disk transcript shape and path remain unresolved.**
Current first-party docs clearly document server-side thread storage, user settings, and local credential storage, but they do not publish a stable local transcript path or schema for the CLI. The repo’s `threads/*.json` claim is therefore unverified, but so is any stronger “no local thread history exists” claim.  
URLs:
- https://ampcode.com/security
- https://ampcode.com/manual

2. **`droid` current persisted transcript root is unresolved between observed `sessions/` and documented `projects/`.**
First-party hook examples use `~/.factory/projects/.../*.jsonl`, while the repo observed `~/.factory/sessions/...`. Without a current first-party filesystem reference page or live capture across versions, the safest conclusion is that the repo’s path should be downgraded from “documented fact” to “observed variant.”  
URLs:
- https://docs.factory.ai/reference/hooks-reference
- https://docs.factory.ai/cli/configuration/settings

3. **`kilo-code` canonical parser target is unresolved across CLI, VS Code extension, and shared-core internals.**
First-party docs support persistent sessions, export/import, and cross-platform continuation; first-party code supports `kilo.db`; first-party issue traffic still shows `ui_messages.json` in active extension builds. The repo should not collapse those into a single storage family yet.  
URLs:
- https://kilo.ai/docs/code-with-ai/platforms/cli
- https://kilo.ai/features/sessions
- https://github.com/Kilo-Org/kilocode/issues/3706
- https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/storage/db.ts

4. **`codex` exact audit guarantees across all modes are unresolved.**
The official docs strongly support local transcript persistence, but the review-mode bug report means a parser redesign should not promise perfect completeness across every feature surface unless OpenAI documents or fixes that gap.  
URLs:
- https://developers.openai.com/codex/cli/features
- https://github.com/openai/codex/issues/4792

## Caveats / Negative Signal

- Some first-party evidence comes from official forums or issue trackers rather than polished docs. That is still first-party, but it usually describes a product moment rather than a long-term contract.
- `cursor`, `amp`, and `droid` are the least contractually documented for raw local storage. The repo’s strongest claims on those tools rely more on observation than on vendor-stated guarantees.
- `kilo-code` has the clearest “both sides can be right” outcome: the shared-core/SQLite story is real, and the extension-side `ui_messages.json` story is also still real in at least some recent builds.

## URLs

- https://github.com/charmbracelet/crush/blob/main/internal/config/load.go
- https://github.com/charmbracelet/crush/blob/main/internal/cmd/root.go
- https://ampcode.com/security
- https://ampcode.com/manual
- https://docs.factory.ai/reference/hooks-reference
- https://docs.factory.ai/cli/droid-exec/overview
- https://docs.factory.ai/cli/configuration/settings
- https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311
- https://forum.cursor.com/t/lost-all-cursor-settings-and-chat-history-for-all-projects-i-am-working-on/151081
- https://forum.cursor.com/t/where-are-cursor-chats-stored/77295/5
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
- https://developers.openai.com/codex/cli/features
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/config-advanced
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/lib.rs
- https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/ResponseItem.ts
- https://github.com/openai/codex/issues/4792
- https://kilo.ai/docs/code-with-ai/platforms/cli
- https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new
- https://kilo.ai/features/sessions
- https://github.com/Kilo-Org/kilocode/issues/3706
- https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/storage/db.ts

# High-Risk Schema Family B Adversarial Verification

## Document Index

| File | Description |
| --- | --- |
| [docs/01-seven-tool-adversarial-verification.md](./docs/01-seven-tool-adversarial-verification.md) | First-party verification of storage, transcript fidelity, and backend-drift claims for `crush`, `amp`, `kilo-code`, `cursor`, `droid`, `copilot`, and `codex`. |

## Critical Findings

- [Amp verification](./docs/01-seven-tool-adversarial-verification.md): the repo’s local JSON thread-store claim is not supported by current first-party docs. Amp’s own security docs say threads are stored on Amp Server in PostgreSQL, while local first-party docs only clearly document settings and credentials paths.
- [Kilo verification](./docs/01-seven-tool-adversarial-verification.md): the repo overstates the “legacy-only” conclusion. First-party April 2026 docs say the extension was rebuilt on a shared core, but a first-party November 2025 issue for extension `4.117.0+` still shows live `ui_messages.json` writes in VS Code `globalStorage`.
- [Droid verification](./docs/01-seven-tool-adversarial-verification.md): the repo’s observed `~/.factory/sessions/...` layout is no longer the best first-party anchor. Factory’s hook docs now show `transcript_path` examples under `~/.factory/projects/.../*.jsonl`.
- [Cursor verification](./docs/01-seven-tool-adversarial-verification.md): the repo’s “tool outputs are missing by design” claim is supported by a first-party staff answer on April 13, 2026.
- [Copilot verification](./docs/01-seven-tool-adversarial-verification.md): the repo is right that `events.jsonl` exists and that `COPILOT_HOME` / `--config-dir` matter, but GitHub’s docs also say the raw session files are the complete record and `session-store.db` is only a subset for `/chronicle`.
- [Codex verification](./docs/01-seven-tool-adversarial-verification.md): the repo is broadly right on local rollouts, `history.jsonl`, and SQLite-backed state, but “rollout equals full forensic record” is weakened by a first-party Codex issue showing review-mode tool calls missing from rollout logs.
- [Crush verification](./docs/01-seven-tool-adversarial-verification.md): current first-party code supports project-local `.crush` data directories, not the home-directory default still asserted in part of the repo research.

## Cross-File Insights

- The repo’s biggest current risk is not “all claims are wrong”; it is inconsistent confidence. The same tool is sometimes described correctly in one local doc and incorrectly in another, especially for `crush` and `kilo-code`.
- Current first-party material increasingly separates “resume substrate” from “search/index/cache” layers. That distinction is explicit for `copilot` and `codex`, implicit for `cursor`, and currently under-documented for `amp`.
- The tools with the strongest evidence of intentional fidelity loss are `cursor` and `codex review mode`: one omits tool outputs by design, the other has a first-party bug report alleging missing review-mode tool events in persisted rollouts.

## Action Items

1. Downgrade confidence for `amp`, `droid`, and `kilo-code` storage-path claims until the parser target surface is explicitly split and labeled.
2. Remove or correct any remaining `~/.crush/crush.db` default-path language; treat project-local `.crush/crush.db` as the current default.
3. Rewrite `kilo-code` docs to distinguish the current shared-core architecture from still-live extension-side `ui_messages.json` evidence.
4. For `copilot`, stop implying that `session.db` is required for transcript completeness unless first-party evidence appears; keep the focus on `session-state/<id>/events.jsonl` plus documented overrides.
5. For `codex`, document that rollouts are primary but not guaranteed to be a perfect audit log for every product surface, citing the review-mode gap.

## Coverage Scope

- Covered: current first-party docs, first-party repo code, first-party issue/forum evidence, and contradictions/support for storage paths, env vars, transcript completeness, and backend drift.
- Not covered: local live captures, private vendor docs, reverse-engineered binary formats, or non-first-party community writeups unless surfaced through official forums.

## Source Roll-Up

- Official docs: 12
- First-party repo code files: 4
- First-party issue/forum threads: 6
- Other: 0

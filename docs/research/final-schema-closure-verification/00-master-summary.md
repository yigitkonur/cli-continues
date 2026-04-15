# Final Schema Closure Verification

Access date: 2026-04-15

This directory captures the final deep internet research pass after the first adversarial wave. Its purpose is to reduce the unresolved set as far as current first-party evidence allows.

## Document Index

| File | Description |
| --- | --- |
| [01-antigravity-amp-droid.md](./01-antigravity-amp-droid.md) | Final closure pass for Antigravity, Amp, and Droid storage/session surfaces. |
| [02-kilo-qwen-kiro.md](./02-kilo-qwen-kiro.md) | Final closure pass for Kilo Code, Qwen Code, and Kiro storage/runtime/schema questions. |
| [03-design-contract.md](./03-design-contract.md) | Final closure pass for the handoff/public-contract design direction. |
| [04-sessionr-debug-contract.md](./04-sessionr-debug-contract.md) | Final closure pass for `sessionr` async semantics and the `--debug-prompt` contract. |

## Biggest Closures

- `Qwen Code` is effectively closed on storage/runtime shape:
  - project-scoped JSONL sessions under `~/.qwen/projects/<sanitized-cwd>/chats/`
  - `QWEN_RUNTIME_DIR` as the runtime-base override
  - `tmp/` and `history/` as auxiliary roots rather than the primary transcript store
- `Kilo Code` is now strongly anchored to a DB-backed OpenCode-derived runtime for the canonical live store.
- `Kiro` is now clearly split:
  - normal CLI chat: SQLite under `~/.kiro/`
  - ACP sessions: `.json` + `.jsonl` under `~/.kiro/sessions/cli/`
- `Antigravity` is better anchored than before:
  - `conversations/*.pb` looks like the persisted conversation payload
  - `brain/<id>/` looks like the artifact sidecar
  - `state.vscdb` / `workspaceStorage/*/state.vscdb` look like UI/index state
  - `code_tracker` still does not have first-party support as canonical transcript storage
- `Droid` now has stronger first-party support for `~/.factory/projects/.../*.jsonl` than for `~/.factory/sessions/...`.
- `Amp` still lacks a first-party published local transcript path/schema; server-backed thread identity remains the safest canonical layer.
- `sessionr --new --async` is now strongly supported as nondeterministic for created-session ID recovery, even though it is not publicly documented as “broken.”

## Final Corrections To Local Confidence

### Strongly confirmed

- Gemini JSONL-first upstream
- Qwen `projects/.../chats/*.jsonl` and `QWEN_RUNTIME_DIR`
- Kilo DB-backed canonical live store
- Kiro split storage surfaces
- Cursor transcript completeness warning
- Copilot `events.jsonl` complete-record / `session-store.db` subset split
- Crush project-local `.crush/crush.db`
- `sessionr` async weak session-ID guarantees

### Downgraded and confidence-graded

- Antigravity canonical storage still unresolved at the exact schema level
- Amp local transcript path/schema still unresolved
- Droid `projects/...` now stronger than `sessions/...`, but versioned/mixed behavior is still plausible
- same-tool debug UX is still unresolved beyond the current hard error
- `default | full` remains plausible for the human-facing view, but not as the only public axis

## Remaining Hard Unresolved Set

- exact Kiro normal-chat SQLite filename/schema
- exact Antigravity protobuf schema and encryption contract
- exact Amp local cache/transcript schema
- exact Droid path/version matrix across `projects/...` vs `sessions/...`
- exact same-tool debug UX contract
- exact public shape of any machine-readable prompt-debug artifact if `continues` adds one

## Action Implication

The implementation phase can move forward now, but it should:

1. confidently fix the strong items
2. confidence-grade the weaker ones
3. avoid pretending the unresolved items are settled

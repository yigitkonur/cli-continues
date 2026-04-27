# Antigravity, Amp, and Droid Closure Pass

## Summary

- `Antigravity`: strongest first-party evidence now points to `~/.gemini/antigravity/conversations/*.pb` as the persisted conversation payload, with `brain/<id>/` as artifacts and `state.vscdb` / `workspaceStorage/*/state.vscdb` as UI/index state.
- `Amp`: strongest first-party model is server-backed thread identity plus a thinner local client-history layer. No first-party public local transcript schema/path was found.
- `Droid`: strongest first-party path is now `~/.factory/projects/.../*.jsonl` via repeated `transcript_path` examples, but releases show storage/session behavior evolving enough that a versioned or mixed model is still plausible.

## New Confirmations

### Antigravity

- Official Google AI Developers Forum bug reports show `.pb` files surviving under `~/.gemini/antigravity/conversations/` alongside `brain/<id>/` even when Agent Manager loses visibility.
- The same reports show `state.vscdb` and `workspaceStorage/*/state.vscdb` acting as UI/index state.

### Amp

- Amp’s security page explicitly separates local thread history from server-side PostgreSQL-backed thread syncing/storage.
- Official product/manual pages make the web/server thread object and `T-...` ID the strongest canonical thread identity surface.

### Droid

- Factory’s hook docs repeatedly show `transcript_path` under `~/.factory/projects/.../*.jsonl`.
- Release notes show active changes to continuation and persistence semantics in late 2025, supporting the “do not over-assume one path behavior” stance.

## New Contradictions

- `code_tracker` still lacks first-party support as Antigravity’s canonical transcript store.
- a concrete local JSON thread path for Amp remains unsupported by first-party docs
- `~/.factory/sessions/...` is no longer the best first-party default path for Droid

## Still Unresolved

- exact Antigravity protobuf schema and whether `code_tracker` has parser value
- exact Amp local cache/transcript schema
- exact Droid coexistence or replacement story for `projects/...` vs `sessions/...`

## URLs

- https://discuss.ai.google.dev/t/bug-report-undo-function-deletes-conversation-from-google-antigravity-agent-manager/111708
- https://discuss.ai.google.dev/t/bug-antigravity-agent-manager-conversation-history-exists-on-remote-host-but-is-not-listed-or-creatable-after-latest-update-remote-ssh-mac-ubuntu/112857
- https://discuss.ai.google.dev/t/antigravity-review/109884
- https://ampcode.com/security
- https://ampcode.com/manual
- https://ampcode.com/manual/appendix
- https://ampcode.com/news/find-threads
- https://ampcode.com/threads/T-f6f27b26-5e1c-42dc-be79-da175de730c6
- https://docs.factory.ai/reference/hooks-reference
- https://docs.factory.ai/cli/droid-exec/overview
- https://docs.factory.ai/changelog/release-notes

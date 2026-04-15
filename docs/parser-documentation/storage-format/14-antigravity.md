# Antigravity

Accessed: 2026-04-15

## Observed Example

- Third-party sync tooling built specifically for Antigravity documents the local root as:
  - `~/.gemini/antigravity/`
- The same tooling says user-visible chat history is in:
  - `conversations/*.pb`
- It also explicitly lists these Antigravity-local paths:
  - `brain/`
  - `knowledge/`
  - `browser_recordings/`
  - `code_tracker/`
  - `implicit/`
  - `google_accounts.json`
  - `oauth_creds.json`
  - `user_settings.pb`
- No env-var override for the Antigravity storage root was surfaced in the available evidence.

## Inference

- `conversations/*.pb` is likely the current user-facing conversation store.
- `code_tracker/` appears machine-local and auxiliary, not the main syncable history substrate, because the sync extension excludes it by default while syncing `conversations/*.pb`.
- Absolute workspace path matters for conversation visibility across machines.

## Unresolved Uncertainty

- I did not find first-party Antigravity storage documentation.
- I did not verify:
  - the protobuf schema for `conversations/*.pb`
  - the exact role of `code_tracker/`
  - the canonical on-disk session ID location
  - append/update behavior for protobuf conversation files
  - whether `code_tracker/` is still a recoverable coding-session source or merely local telemetry/index data

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/antigravity.ts` assume `~/.gemini/antigravity/code_tracker/` contains JSON or JSONL session files with `type`, `content`, and `timestamp`.
- External evidence points elsewhere:
  - synced conversation history appears protobuf-backed in `conversations/*.pb`
  - `code_tracker/` is excluded from sync
- Risk: very high. The current parser may be aimed at an auxiliary store rather than the product’s primary conversation history.

## Direct Access Recipe

- Inspect root:
  - `~/.gemini/antigravity/`
- Compare:
  - `conversations/*.pb`
  - `code_tracker/`
  - `browser_recordings/`

## Sources

- Third-party extension evidence: https://marketplace.visualstudio.com/items?itemName=mrd9999.antigravity-sync

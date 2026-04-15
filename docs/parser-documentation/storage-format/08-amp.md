# Amp

Accessed: 2026-04-15

## Documented Fact

- Official configuration roots:
  - workspace settings: nearest `.amp/settings.json` or `.amp/settings.jsonc`
  - user settings: `~/.config/amp/settings.json` or `.jsonc`
- Official credential/session-adjacent paths:
  - `~/.amp/oauth/`
  - `~/.local/share/amp/secrets.json`
- Official thread/session behavior:
  - thread IDs use `T-...`
  - `amp threads continue` resumes an existing thread
  - threads can be archived, shared, and referenced by thread ID or URL
- Official docs confirm that local thread history exists, but they do not publish a storage-format schema for it.
- No official storage-root env-var override for thread history was found.

## Observed Example

- An official public Amp thread shows a macOS local filesystem listing under `~/.config/amp` with:
  - `history.jsonl`
  - `session.json`
  - `threads/`
  - `ide/`
  - `migration/`
- That same thread explicitly failed to find an alternate `~/Library/Application Support/amp` tree on that machine.

## Inference

- Amp currently uses a mixed local layout:
  - config in `~/.config/amp`
  - secrets in `~/.local/share/amp`
  - thread data likely rooted in `~/.config/amp/threads`
- `history.jsonl` strongly suggests append-oriented history storage, but the exact per-thread file schema remains undocumented.

## Unresolved Uncertainty

- I did not find first-party documentation that proves:
  - per-thread file format
  - whether `threads/` contains one JSON file per thread
  - whether `session.json` tracks the active thread pointer only
  - whether any XDG env var overrides the thread-history root

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/amp.ts` assume `~/.local/share/amp/threads/*.json` via `XDG_DATA_HOME`.
- Upstream evidence contradicts that as the default macOS reality:
  - official docs place settings in `~/.config/amp`
  - official thread evidence places `history.jsonl`, `session.json`, and `threads/` in `~/.config/amp`
  - official security docs place only credentials in `~/.local/share/amp/secrets.json`
- Risk: very high. The parser appears aimed at an outdated or partial storage model.

## Direct Access Recipe

- Inspect current local state:
  - `~/.config/amp/history.jsonl`
  - `~/.config/amp/session.json`
  - `~/.config/amp/threads/`
  - `~/.local/share/amp/secrets.json`

## Sources

- Official docs: https://ampcode.com/manual
- Official docs: https://ampcode.com/security
- Official public thread: https://ampcode.com/threads/T-019b10cd-e818-774c-bd65-8622bd15cf35

# Open Questions

## Highest-priority follow-ups

- `antigravity`: discovery is now fixed around `.pb` conversations, brain artifacts, state summaries, and optional live RPC. Remaining gap: offline `.pb` transcript/tool-call decoding without private schema assumptions.
- `kiro`: is `continues` meant to support Kiro CLI, Kiro IDE, or both? Official docs say SQLite under `~/.kiro/`; current parser targets JSON files under `Application Support/Kiro/workspace-sessions/`.
- `kilo-code`: which backend is canonical today?
  - First-party issue evidence still references `ui_messages.json` under VS Code globalStorage.
  - Current official repo also ships OpenCode-style `ToolPart` and `Session` code with `kilocode_change` customizations.
- `cursor`: first-party staff say transcript JSONL intentionally excludes tool outputs. Do all Cursor agent-transcript builds at least persist tool inputs on disk, and if so in what exact shape?
- `copilot`: GitHub documents a complete local session record plus `~/.copilot/session-store.db`, but the exact location of tool results and file-modification detail still needs direct schema confirmation.
- `kimi`: when does `context.jsonl` remain empty while `wire.jsonl` is populated? Current parser likely needs a `wire.jsonl` fallback or at least a better session-discovery rule.

## Redesign questions

- Should `continues` carry both:
  - a human summary grouped into read/write/edit/search/shell buckets
  - and a raw-tool appendix preserving exact upstream names plus argument/result carriers?
- Should storage adapters declare version families explicitly?
  - Example: Gemini legacy `.json` vs current JSONL
  - Example: possible Kilo legacy `ui_messages.json` vs OpenCode-style backend
- Should the top-of-handoff pointer block include a “raw fidelity class”?
  - `full`: exact name + args + result + diff metadata available
  - `partial`: exact name + args only, or UI-layer summary only
  - `opaque`: no trustworthy raw tool-call storage confirmed

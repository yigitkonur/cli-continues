# Open Questions

Accessed: 2026-04-15

## Highest Priority

1. Factory Droid
   We still do not have first-party proof that live session transcripts are stored in `~/.factory/sessions/<workspace>/<id>.jsonl` with sibling `.settings.json` files. The current parser may be right, but the evidence is still indirect.

2. Cursor
   How much session fidelity lives only in `agent-transcripts`, and how much depends on Cursor IDE state such as `state.vscdb` or workspace storage? `continues` currently parses only transcripts.

3. Kiro
   Is `continues` supposed to support Kiro IDE, Kiro CLI, or both? The public docs now point to Kiro CLI SQLite in `~/.kiro/`, while the current parser targets a macOS app-support JSON layout that I could not verify publicly.

4. Antigravity
   Which store should count as the canonical “session” source for parser work:
   - `conversations/*.pb`
   - `code_tracker/`
   - or both?

5. Amp
   What is the exact on-disk schema inside `~/.config/amp/threads/`?
   Current evidence shows the directory exists, but not whether its members are JSON, JSONL, or another structure.

## Medium Priority

6. Copilot CLI
   Is `workspace.yaml` still a stable and supported filename, or should `continues` stop depending on it and derive metadata from `events.jsonl` plus `session-store.db`?

7. Claude Code
   What exact thresholds or rules move tool outputs into `tool-results/` versus leaving them inline in the main transcript JSONL?

8. Cursor Session ID
   Is the transcript filename always the canonical session ID, or is that only a convenient local parser heuristic?

## Suggested Follow-Up Research

- Run live captures for Droid, Amp, Cursor, Kiro, and Antigravity on fresh installs.
- Record exact file trees after:
  - first prompt
  - tool call
  - resume
  - delete/archive
  - export/share
- Compare those live captures to the parser assumptions before redesigning the registry/help text.

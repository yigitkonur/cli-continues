# Cursor Open Issues For This Comparison

## 1. Do modern local `agent-transcripts` now include tool-input blocks consistently?

Why unresolved:

- Cursor staff wrote on 2026-03-14 that `.jsonl` had dropped `tool_use` and a fix should land in a later release.
- Cursor staff wrote on 2026-04-13 that JSONL transcript files include tool call inputs but not tool outputs.
- The local transcript samples inspected for this review were still text-only.

What to test next:

- Generate a fresh Cursor agent session on a current stable build that definitely invokes file-edit and shell tools.
- Inspect the raw `~/.cursor/projects/<slug>/agent-transcripts/...jsonl` immediately.
- Record whether block types include non-text tool entries, and whether `model`/`usage` passthroughs are present.

Why it matters:

- This decides whether [`/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts`](/Users/yigitkonur/dev/cli-continues/src/parsers/cursor.ts) is merely ahead of the docs or genuinely over-assuming the source.

## 2. Are local `agent-transcripts` and exported transcripts produced by the same pipeline?

Why unresolved:

- First-party forum evidence shows exported transcripts still missing command/file-edit content in March 2026.
- First-party forum replies about local JSONL transcript files suggest more local information may exist.
- Cursor Help docs document sharing/export semantics but not local storage schema.

What to test next:

- Run one session.
- Compare:
  - raw local `agent-transcripts` JSONL
  - exported transcript JSONL/text from the UI
  - shared transcript content
- Diff for tool inputs, tool outputs, thinking, and file-edit details.

Why it matters:

- Both parsers need to avoid importing export assumptions into local-parser confidence.

## 3. How durable is `~/.cursor/chats/.../store.db` as a supported local source?

Why unresolved:

- It exists and is useful on this machine.
- `agentlytics` gets real value from it.
- Cursor public docs do not document it.

What to test next:

- Check multiple Cursor versions and clean installs on macOS, Linux, and Windows.
- Confirm whether `store.db` is always present for agent sessions, only present on some modes, or a transitional artifact.
- Track whether `agentId` in `store.db.meta` always matches transcript/session IDs.

Why it matters:

- This is the strongest current source for richer Cursor recovery, but also the least publicly supportable one.

## 4. Is agentlytics’ DB-backed source 2 still valid on current macOS installs?

Why unresolved:

- `editors/cursor.js` expects:
  - `~/Library/Application Support/Cursor/User/workspaceStorage`
  - `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Those paths were absent on this machine during review.
- First-party recovery threads still mention `state.vscdb` and `workspaceStorage`.

What to test next:

- Verify on a current macOS install with known Composer chats.
- Determine whether the paths moved, are created lazily, or are only present in some install modes.

Why it matters:

- If source 2 is stale, agentlytics is strongest mainly because of `store.db`, not because of its app-data DB recovery path.

## 5. Should `cli-continues` add a documented warning gate before any Cursor tool summary?

Why unresolved:

- The docs already say yes in substance.
- The parser code still emits normalized tool summaries with no Cursor-specific warning block.

What to test next:

- Prototype a handoff banner that always appears for Cursor:
  - raw transcript path
  - completeness caveat
  - explicit note that tool outputs may be absent
- Evaluate whether that is enough without adding a second ingestion path.

Why it matters:

- This is the lowest-risk way to align code behavior with documented Cursor uncertainty.

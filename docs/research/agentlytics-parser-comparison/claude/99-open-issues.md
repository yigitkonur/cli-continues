# Open Issues For Claude Comparison

**Scope:** Remaining Claude-specific questions that neither `continues` nor agentlytics can fully settle from current first-party docs alone.
**Last updated:** 2026-04-15
**Confidence:** Medium — grounded by current docs and local observation, but blocked by missing upstream schema documentation

## Open questions

### 1. Is `sessions-index.json` still live, transitional, or deprecated?

**Why it matters:** agentlytics reads it as a normal metadata source, while `continues` ignores it.

**What is known**

- Anthropic issue `#25032` shows the file existed and could become stale enough to break `claude --resume`.
- Current Anthropic `.claude` directory docs do not list it.
- Current local Claude storage on this machine did not contain it on 2026-04-15.

**Current best judgment**

Treat `sessions-index.json` as optional legacy or transitional state, not canonical storage.

### 2. What exactly determines `tool-results/` spillover?

**Why it matters:** both tools need to know whether large outputs are only an optimization or are necessary for lossless recovery.

**What is known**

- Anthropic docs explicitly say large tool outputs can spill into `projects/<project>/<session>/tool-results/`.
- Current local storage contains multiple such files.
- Anthropic does not document the threshold or routing logic.

**Current best judgment**

A Claude parser that ignores `tool-results/` cannot claim full-fidelity session recovery.

### 3. Is `toolUseResult` stable enough to parse as a real schema?

**Why it matters:** this is the largest currently unparsed Claude-specific fidelity surface in `continues`, and agentlytics ignores it too.

**What is known**

- Current local Claude transcripts include top-level `toolUseResult` objects with structured fields like `stdout`, `stderr`, `filenames`, `durationMs`, and other tool-specific payloads.
- Anthropic public docs do not yet document this object.

**Current best judgment**

The field is real and valuable, but parser support should be guarded with tolerant schema handling because upstream has not published a stable contract.

### 4. How much of Claude compaction can be reconstructed from transcripts alone?

**Why it matters:** `continues` chains prior sessions heuristically; agentlytics does not try.

**What is known**

- Anthropic hooks docs expose `PreCompact` and `PostCompact`, plus `compact_summary`.
- Current local transcripts contain `isCompactSummary`.
- Anthropic does not document deterministic predecessor linkage between compacted and prior sessions.

**Current best judgment**

Our current predecessor chaining is useful but heuristic, not guaranteed.

## Sources

- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/hooks
- https://github.com/anthropics/claude-code/issues/25032
- https://raw.githubusercontent.com/f/agentlytics/master/editors/claude.js
- /Users/yigitkonur/dev/cli-continues/src/parsers/claude.ts
- /Users/yigitkonur/dev/cli-continues/docs/parser-documentation/tool-call-map/01-claude.md

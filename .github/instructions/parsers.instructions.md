---
applyTo: "src/parsers/**/*.ts"
---

# Parser Review Guidelines

## Crash Safety (Critical)

- Parsers MUST NOT throw to the caller — each runs inside `Promise.allSettled` and an uncaught error silently drops that tool's sessions from the index
- Wrap JSON.parse calls and file-read loops in try-catch with an empty catch block to silently skip malformed data

```typescript
// Good — CLI continues if one line is malformed
for (const line of lines) {
  try {
    const data = JSON.parse(line);
    // process...
  } catch {
    // Skip malformed line silently
  }
}

// Bad — one bad line crashes the entire parser
for (const line of lines) {
  const data = JSON.parse(line);
}
```

## Required Exports

Each parser file must export exactly two functions:

- `parse<Tool>Sessions(): Promise<UnifiedSession[]>` — file discovery and metadata extraction
- `extract<Tool>Context(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext>` — full conversation and tool activity extraction

Both must be registered in `src/parsers/registry.ts` with all `ToolAdapter` fields populated.

## JSONL Streaming

- Stream JSONL with helpers from `src/utils/jsonl.ts` (`readJsonlFile`, `scanJsonlHead`) when applicable
- Never use `fs.readFileSync` for session files
- Keep only the last ~10 messages in `recentMessages` — do not accumulate the entire conversation

## Tool Summarizer

- Always use `SummaryCollector` from `src/utils/tool-summarizer.ts` — never build `ToolUsageSummary[]` arrays manually
- Call `collector.add(category, summary, filePath?, isWrite?)` for each tool invocation

## Shared Helpers

- Import `cleanSummary`, `extractRepoFromCwd`, `homeDir` from `src/utils/parser-helpers.ts`
- Do not duplicate these utilities in individual parser files

## New Tool Checklist

Adding a new tool requires ALL five of:

1. Parser file `src/parsers/<tool>.ts` exporting both required functions
2. Registry entry in `src/parsers/registry.ts` with all `ToolAdapter` fields
3. Type update in `src/types/tool-names.ts` — add to `SessionSource` union and `TOOL_NAMES` array
4. Fixture factory in `src/__tests__/fixtures/index.ts`
5. Conversion tests in `src/__tests__/unit-conversions.test.ts` for all N-1 paths in each direction

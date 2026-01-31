# Developer Guide - Codex Session Picker (sessionr)

This document provides an overview of the architecture and development guidelines for the Unified Session Picker.

## Architecture Overview

`sessionr` acts as a unified interface for multiple AI CLI tools (Codex, Claude, and Copilot). It solves the problem of "where did I leave off?" by providing a searchable index of all recent AI interactions across different tools.

### High-Level Components

```
src/
├── cli.ts           # Entry point, CLI command definitions (Commander.js)
├── types/
│   └── index.ts     # Unified session and context data models
├── parsers/         # Tool-specific parsing logic
│   ├── index.ts     # Parser exports
│   ├── codex.ts     # Parser for Codex (~/.codex/sessions)
│   ├── claude.ts    # Parser for Claude (~/.claude/projects)
│   └── copilot.ts   # Parser for Copilot (~/.copilot/session-state)
└── utils/
    ├── index.ts     # Indexing, caching, and shared utilities
    └── resume.ts    # Resume logic (native and cross-tool)
```

## Core Concepts

### 1. Unified Session (`UnifiedSession`)
All sessions from different tools are normalized into a single interface. This includes common metadata like `id`, `cwd`, `repo`, `branch`, `summary`, and timestamps.

### 2. Session Discovery and Indexing
Parsing dozens of session files on every startup is slow. `sessionr` implements a simple caching mechanism:
- Sessions are discovered by scanning tool-specific directories.
- Parsed metadata is stored in `~/.sessionr/sessions.jsonl`.
- The index has a TTL (default 5 minutes) but can be forced to rebuild with `--rebuild`.

### 3. Cross-Tool Resume (The "Handoff")
This is the core feature that allows starting a session in Codex and continuing it in Claude.
- **Context Extraction**: The original parser extracts the last N messages and relevant metadata.
- **Markdown Generation**: A standardized "Handoff Markdown" is generated containing the session summary and recent conversation.
- **Injection**: The target tool is launched, and the markdown is passed as the initial prompt (via stdin or CLI arguments).

## Development Workflows

### Adding a New Tool
To support a new AI CLI:
1.  **Define Source**: Add the tool name to `SessionSource` in `src/types/index.ts`.
2.  **Create Parser**: Implement a new parser in `src/parsers/` following the existing patterns:
    - Locate the tool's local session storage.
    - Parse its internal format (JSONL, SQLite, etc.) into `UnifiedSession`.
    - Implement context extraction to `SessionContext`.
3.  **Register Parser**: Add the new parser to `src/parsers/index.ts` and update `src/utils/index.ts` to include it in the discovery process.
4.  **Implement Resume**: Update `src/utils/resume.ts` with the native resume command and injection strategy for the new tool.

### Build and Test
```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev -- pick

# Link locally for testing as 'sessionr'
npm run link
```

## Storage Locations
- **Config & Index**: `~/.sessionr/`
- **Session Index**: `~/.sessionr/sessions.jsonl`
- **Extracted Contexts**: `~/.sessionr/contexts/` (temporary MD files for handoffs)

## Guidelines
- **Performance**: Keep the initial "discovery" phase fast. Avoid reading full conversation histories until a specific session is selected.
- **Error Handling**: Gracefully handle missing directories or corrupted session files. Many tools might not be installed on a user's system.
- **TTY Handling**: When launching sub-processes (CLIs), ensure they inherit the parent's TTY (`stdio: 'inherit'`) to maintain interactivity.

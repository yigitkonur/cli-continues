# Changelog

All notable changes to `continues` will be documented in this file.

## [2.7.0] - 2026-02-19

### Added

- **Factory Droid support** — `continues` now discovers and parses sessions from [Factory's Droid CLI](https://www.factory.ai/). Full support for cross-tool handoff to and from Droid, including:
  - Session discovery from `~/.factory/sessions/`
  - File operations: `Create`, `Read`, `Edit`, `ApplyPatch`
  - Shell commands: `Execute`, `Bash`
  - MCP tool calls (e.g. `context7___query-docs`)
  - Thinking blocks extracted as reasoning highlights
  - Token usage and model info from companion `.settings.json`
  - Pending tasks from `todo_state` events
- Quick-resume: `continues droid` / `continues droid 3`
- `droid` added to interactive picker, `list --source droid`, `scan`, and cross-tool handoff targets
- Test coverage: 30 conversion paths (up from 20) covering all 6×5 source→target combinations

## [2.6.7] - 2026-02-19

Previous release. Supported Claude Code, GitHub Copilot CLI, Gemini CLI, Codex CLI, and OpenCode.

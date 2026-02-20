# continues

> Pick up where you left off — seamlessly continue AI coding sessions across Claude, Copilot, Gemini, Codex, OpenCode & Droid.

```bash
npx continues
```

https://github.com/user-attachments/assets/6945f3a5-bd19-45ab-9702-6df8e165a734


[![npm version](https://img.shields.io/npm/v/continues.svg)](https://www.npmjs.com/package/continues)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why?

Have you ever hit your daily limit on Claude Code mid-debug? Or burned through your Gemini quota right when things were getting interesting?

You've built up 30 messages of context — file changes, architecture decisions, debugging history. And now you either wait hours for the limit to reset, or start fresh in another tool and explain everything from scratch.

**`continues` reads your session from any supported tool, extracts the context, and injects it into whichever tool you switch to.** Your conversation history, file changes, and working directory all come along.

## Features

- 🔄 **Cross-tool handoff** — Move sessions between Claude, Copilot, Gemini, Codex, OpenCode & Droid
- 🔍 **Auto-discovery** — Scans all 6 tools' session directories automatically
- 🛠️ **Tool activity extraction** — Parses shell commands, file edits, MCP tool calls, patches, and more from every session
- 🧠 **AI reasoning capture** — Extracts thinking blocks, agent reasoning, and model info for richer handoffs
- 📋 **Interactive picker** — Browse, filter, and select sessions with a beautiful TUI
- ⚡ **Quick resume** — `continues claude` / `continues codex 3` — one command, done
- 🔒 **Tool flags** — pass autonomy/safety flags directly at launch (`--full-auto`, `--yolo`, `--dangerously-skip-permissions`, etc.)
- 🖥️ **Scriptable** — JSON/JSONL output, TTY detection, non-interactive mode
- 📊 **Session stats** — `continues scan` to see everything at a glance

## Installation

No install needed — just run:

```bash
npx continues
```

Or install globally:

```bash
npm install -g continues
```

Both `continues` and `cont` work as commands after global install.

## Quick Start

```bash
# Interactive session picker — browse, pick, switch tools
continues

# List all sessions across every tool
continues list

# Grab a Claude session and continue it in Gemini
continues resume abc123 --in gemini

# Resume in Codex with full-auto mode
continues resume abc123 --in codex --full-auto

# Quick-resume your latest Claude session (native resume)
continues claude

# Quick-resume Codex in yolo mode (no approvals, no sandbox)
continues codex --yolo
```

## Usage

### Interactive Mode (default)

Just run `continues`. It walks you through:

1. Filter by directory, CLI tool, or browse all
2. Pick a session
3. Choose which CLI tool to continue in (only shows *other* tools — the whole point is switching)

When you run `continues` from a project directory, it prioritizes sessions from that directory first:

```
┌  continues — pick up where you left off
│
│  ▸ 12 sessions found in current directory
│  Found 904 sessions across 5 CLI tools
│    claude: 723  codex: 72  copilot: 39  opencode: 38  gemini: 31
│
◆  Filter sessions
│  ● This directory (12 sessions)
│  ○ All CLI tools (904 sessions)
│  ○ Claude (723)
│  ○ Codex (72)
│  ○ Copilot (39)
│  ○ Opencode (38)
│  ○ Gemini (31)
└

◆  Select a session (12 available)
│  [claude]    2026-02-19 05:28  my-project    Debugging SSH tunnel config   84a36c5d
│  [copilot]   2026-02-19 04:41  my-project    Migrate presets from Electron c2f5974c
│  [codex]     2026-02-18 23:12  my-project    Fix OpenCode SQLite parser    a1e90b3f
│  ...
└

◆  Continue claude session in:
│  ○ Gemini
│  ○ Copilot
│  ○ Codex
│  ○ OpenCode
└
```

If no sessions are found for the current directory, all sessions are shown automatically.

### Non-interactive

```bash
continues list                          # List all sessions
continues list --source claude --json   # JSON output, filtered
continues list --jsonl -n 10            # JSONL, limit to 10
continues scan                          # Session discovery stats
continues rebuild                       # Force-rebuild the index
```

`list` output:

```
Found 894 sessions (showing 5):

[claude]   2026-02-19 05:28  dev-test/SuperCmd     SSH tunnel config debugging         84a36c5d
[copilot]  2026-02-19 04:41  migrate-to-tauri      Copy Presets From Electron          c2f5974c
[codex]    2026-02-18 23:12  cli-continues         Fix OpenCode SQLite parser          a1e90b3f
[gemini]   2026-02-18 05:10  my-project            Tauri window management             96315428
[opencode] 2026-02-14 17:12  codex-session-picker  Where does Codex save JSON files    ses_3a2d
```

### Quick Resume

Resume the Nth most recent session from a specific tool using native resume (no context injection — fastest, preserves full history):

```bash
continues claude        # Latest Claude session
continues codex 3       # 3rd most recent Codex session
continues copilot       # Latest Copilot session
continues gemini 2      # 2nd most recent Gemini session
continues opencode      # Latest OpenCode session
continues droid         # Latest Droid session
```

Tool-specific flags can be passed directly:

```bash
continues codex --full-auto                    # workspace-write sandbox + on-request approvals
continues codex --yolo                         # no sandbox, no approvals
continues codex --sandbox workspace-write
continues codex --ask-for-approval never
continues codex 3 --model o4-mini

continues claude --dangerously-skip-permissions
continues claude --permission-mode plan
continues claude --model claude-opus-4-5

continues gemini --yolo                        # maps to --approval-mode yolo
continues gemini --approval-mode auto_edit
continues gemini --gemini-sandbox

continues droid --auto high
continues droid --skip-permissions-unsafe
continues droid --model gpt-4o
```

### Cross-tool Handoff

This is the whole point. Start in one tool, finish in another:

```bash
# You were debugging in Claude, but hit the rate limit.
# Grab the session ID from `continues list` and hand it off:
continues resume abc123 --in gemini

# Hand off to Codex and launch in full-auto mode:
continues resume abc123 --in codex --full-auto

# Hand off to Claude and skip all permission prompts:
continues resume abc123 --in claude --dangerously-skip-permissions

# Hand off to Gemini in yolo mode:
continues resume abc123 --in gemini --yolo

# Or pick interactively — just run `continues`, select a session,
# and choose a different tool as the target.
```

`continues` extracts your conversation context (messages, file changes, pending tasks) and injects it as a structured prompt into the target tool. The target picks up with full awareness of what you were working on.

## How It Works

```
1. Discovery    → Scans session directories for all 6 tools
2. Parsing      → Reads each tool's native format (JSONL, JSON, SQLite, YAML)
3. Extraction   → Pulls recent messages, file changes, tool activity, AI reasoning
4. Summarizing  → Groups tool calls by type with concise one-line samples
5. Handoff      → Generates a structured context document
6. Injection    → Launches target tool with the context pre-loaded
```

### Tool Activity Extraction

Every tool call from the source session is parsed, categorized, and summarized. The handoff document includes a **Tool Activity** section so the target tool knows exactly what was done — not just what was said.

Shared formatting helpers (`SummaryCollector` + per-tool formatters in `src/utils/tool-summarizer.ts`) keep summaries consistent across all 6 CLIs. Adding support for a new tool type is a one-liner.

**What gets extracted per CLI:**

| Tool | Extracted |
|:-----|:----------|
| Claude Code | Bash commands (with exit codes), Read/Write/Edit (file paths), Grep/Glob, WebFetch/WebSearch, Task/subagent dispatches, MCP tools (`mcp__*`), thinking blocks → reasoning notes |
| Codex CLI | exec_command/shell_command (grouped by base command: `npm`, `git`, etc.), apply_patch (file paths from patch format), web_search, write_stdin, MCP resources, agent_reasoning → reasoning notes, token usage |
| Gemini CLI | read_file/write_file (with `diffStat`: +N -M lines), thoughts → reasoning notes, model info, token usage (accumulated) |
| Copilot CLI | Session metadata from workspace.yaml (tool calls not persisted by Copilot) |
| OpenCode | Messages from SQLite DB or JSON fallback (tool-specific parts TBD) |
| Factory Droid | Create/Read/Edit (file paths), Execute/Bash (shell commands), LS, MCP tools (`context7___*`, etc.), thinking blocks → reasoning notes, todo tasks, model info, token usage from companion `.settings.json` |

**Example handoff output:**

```markdown
## Tool Activity
- **Bash** (×47): `$ npm test → exit 0` · `$ git status → exit 0` · `$ npm run build → exit 1`
- **Edit** (×12): `edit src/auth.ts` · `edit src/api/routes.ts` · `edit tests/auth.test.ts`
- **Grep** (×8): `grep "handleLogin" src/` · `grep "JWT_SECRET"` · `grep "middleware"`
- **apply_patch** (×5): `patch: src/utils/db.ts, src/models/user.ts`

## Session Notes
- **Model**: claude-sonnet-4
- **Tokens**: 45,230 input, 12,847 output
- 💭 Need to handle the edge case where token refresh races with logout
- 💭 The middleware chain order matters — auth must come before rate limiting
```

### Session Storage

`continues` reads session data from each tool's native storage. Read-only — it doesn't modify or copy anything.

| Tool | Location | Format |
|:-----|:---------|:-------|
| Claude Code | `~/.claude/projects/` | JSONL |
| GitHub Copilot | `~/.copilot/session-state/` | YAML + JSONL |
| Google Gemini CLI | `~/.gemini/tmp/*/chats/` | JSON |
| OpenAI Codex | `~/.codex/sessions/` | JSONL |
| OpenCode | `~/.local/share/opencode/` | SQLite |
| Factory Droid | `~/.factory/sessions/` | JSONL + JSON |

Session index cached at `~/.continues/sessions.jsonl`. Auto-refreshes when stale (5 min TTL).

## Commands

```
continues                           Interactive TUI picker (default)
continues list                      List all sessions
continues resume <id>               Resume by session ID
continues resume <id> --in <tool>   Cross-tool handoff
continues scan                      Session discovery statistics
continues rebuild                   Force-rebuild session index
continues <tool> [n]                Quick-resume Nth session from tool
```

### `continues` / `continues pick`

Interactive session picker. Requires a TTY.

| Flag | Description |
|:-----|:------------|
| `-s, --source <tool>` | Pre-filter to one tool |
| `--no-tui` | Disable interactive mode |
| `--rebuild` | Force-rebuild index first |

### `continues list` (alias: `ls`)

| Flag | Description | Default |
|:-----|:------------|:--------|
| `-s, --source <tool>` | Filter by tool | all |
| `-n, --limit <number>` | Max sessions to show | 50 |
| `--json` | Output as JSON array | — |
| `--jsonl` | Output as JSONL | — |
| `--rebuild` | Force-rebuild index first | — |

### `continues resume <id>` (alias: `r`)

| Flag | Description | Default |
|:-----|:------------|:--------|
| `-i, --in <tool>` | Target tool for cross-tool handoff | — |
| `--reference` | Use file reference instead of inline context (large sessions) | — |
| `--no-tui` | Skip interactive prompts | — |
| **Codex flags** | | |
| `--full-auto` | Workspace-write sandbox with on-request approvals | — |
| `--yolo` | Bypass all approvals and sandbox restrictions | — |
| `--sandbox <mode>` | Sandbox mode: `read-only`, `workspace-write`, `danger-full-access` | — |
| `--ask-for-approval <policy>` | Approval policy: `on-request`, `untrusted`, `never` | — |
| **Claude flags** | | |
| `--dangerously-skip-permissions` | Skip all permission prompts | — |
| `--permission-mode <mode>` | Permission mode (e.g. `plan`) | — |
| **Gemini flags** | | |
| `--approval-mode <mode>` | Approval mode: `default`, `auto_edit`, `yolo` | — |
| `--gemini-sandbox` | Run in sandboxed environment | — |
| **Droid flags** | | |
| `--auto <level>` | Autonomy level: `low`, `medium`, `high` | — |
| `--skip-permissions-unsafe` | Skip all permission prompts (dangerous) | — |
| **Shared** | | |
| `--model <name>` | Model to use (forwarded to the target tool) | — |

Flags are forwarded to whichever tool is launched (native or cross-tool target). Flags irrelevant to the target tool are silently ignored — e.g. `--full-auto` does nothing when the target is Claude.

### `continues scan`

| Flag | Description |
|:-----|:------------|
| `--rebuild` | Force-rebuild index first |

### `continues <tool> [n]`

Quick-resume using native resume (same tool, no context injection).  
Tools: `claude`, `copilot`, `gemini`, `codex`, `opencode`, `droid`. Default `n` is 1.

Each tool supports its own flags:

| Tool | Supported flags |
|:-----|:----------------|
| `codex` | `--full-auto`, `--yolo`, `--sandbox <mode>`, `--ask-for-approval <policy>`, `--model <name>` |
| `claude` | `--dangerously-skip-permissions`, `--permission-mode <mode>`, `--model <name>` |
| `gemini` | `--yolo`, `--approval-mode <mode>`, `--gemini-sandbox`, `--model <name>` |
| `droid` | `--auto <level>`, `--skip-permissions-unsafe`, `--model <name>` |
| `copilot` | *(no startup autonomy flags)* |
| `opencode` | *(no startup autonomy flags)* |

## Conversion Matrix

All 30 cross-tool paths are supported and tested:

|  | → Claude | → Copilot | → Gemini | → Codex | → OpenCode | → Droid |
|:--|:--------:|:---------:|:--------:|:-------:|:----------:|:-------:|
| **Claude** | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Copilot** | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| **Gemini** | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| **Codex** | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| **OpenCode** | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Droid** | ✅ | ✅ | ✅ | ✅ | ✅ | — |

Same-tool resume is available via `continues <tool>` shortcuts (native resume, not shown in matrix).

## Requirements

- **Node.js 22+** (uses built-in `node:sqlite` for OpenCode parsing)
- At least one of: Claude Code, GitHub Copilot, Gemini CLI, Codex, OpenCode or Droid

## Development

```bash
git clone https://github.com/yigitkonur/cli-continues
cd cli-continues
pnpm install

pnpm run dev          # Run with tsx (no build needed)
pnpm run build        # Compile TypeScript
pnpm test             # Run 122 tests
pnpm run test:watch   # Watch mode
```

## License

MIT © [Yigit Konur](https://github.com/yigitkonur)

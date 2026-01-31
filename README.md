<div align="center">

# 🔄 continues

### Never lose context. Pick up exactly where you left off.

**The universal session manager for AI coding assistants.**

[![npm version](https://img.shields.io/npm/v/continues.svg?style=flat-square)](https://www.npmjs.com/package/continues)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square)](https://nodejs.org)

[Installation](#-installation) • [Quick Start](#-quick-start) • [Features](#-features) • [Commands](#-commands)

</div>

---

## 💡 The Problem

You're deep in a coding session with Claude. Context is rich. Progress is flowing. Then you need to switch to Copilot for a specific task. Or Codex for its reasoning. Or you just closed the terminal.

**Your context is gone.** You start over. Again.

## ✨ The Solution

**continues** indexes every session across all your AI coding assistants and lets you:

- 📋 **Browse all sessions** from Codex, Claude, Copilot, Gemini & OpenCode in one unified view
- 🔄 **Resume instantly** in the original tool with native commands
- 🌉 **Cross-tool handoff** — start in Claude, continue in Copilot with full context injection
- ⚡ **Never lose work** — your AI conversations persist and remain accessible

---

## 📦 Installation

```bash
# Install globally via npm
npm install -g continues

# That's it. Run it.
continues
```

### Requirements
- Node.js 18+
- At least one of: [Codex](https://github.com/openai/codex), [Claude Code](https://claude.ai), [GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli), [Gemini CLI](https://cloud.google.com/gemini), or [OpenCode](https://github.com/opencode-ai/opencode)

---

## 🚀 Quick Start

```bash
# Launch the interactive picker
continues

# Or use the short alias
cont
```

You'll see a unified list of all your AI coding sessions:

```
? Select a session to resume:
❯ [gemini]   2026-01-31 06:52  my-project  main   Create API documentation...
  [copilot]  2026-01-31 06:46  backend     main   Fix authentication bug...
  [claude]   2026-01-31 06:13  frontend    feat   Refactor components...
  [codex]    2026-01-30 14:20  ml-service  dev    Optimize model inference...
  [opencode] 2026-01-30 12:00  cli-tool    main   Add new commands...
```

Select a session, choose your target tool, and you're back in action.

---

## ✨ Features

### 🔍 Unified Session Discovery

All your AI coding sessions in one place. No more hunting through different directories or remembering which tool you used.

```bash
continues list                    # See all sessions
continues list --source claude    # Filter by tool
continues list --limit 50         # Show more
```

### ⚡ Instant Resume

Jump back into any session with a single command:

```bash
continues                  # Interactive picker
continues codex            # Resume latest Codex session
continues claude 2         # Resume 2nd newest Claude session
continues resume abc123    # Resume by session ID
```

### 🌉 Cross-Tool Handoff

The killer feature. Start a session in one tool, continue in another:

```bash
continues resume abc123 --target copilot
```

**continues** extracts your conversation context and injects it into the new tool as a rich handoff document:

```markdown
# Session Handoff Context

## Original Session
- **Source**: Claude Code
- **Working Directory**: /Users/dev/my-project
- **Repository**: user/my-project @ main

## Recent Conversation
### User
Fix the authentication bug in the login endpoint...

### Assistant  
I'll investigate the authentication flow...

---
**Continue this session. The context above summarizes the previous work.**
```

### 🎨 Color-Coded Interface

Each tool has its own color for instant recognition:

| Tool | Color |
|------|-------|
| Codex | 🟣 Magenta |
| Claude | 🔵 Blue |
| Copilot | 🟢 Green |
| Gemini | 🔵 Cyan |
| OpenCode | 🟡 Yellow |

---

## 📖 Commands

| Command | Description |
|---------|-------------|
| `continues` | Interactive session picker |
| `continues list` | List all sessions |
| `continues rebuild` | Force rebuild session index |
| `continues codex [n]` | Resume Nth Codex session |
| `continues claude [n]` | Resume Nth Claude session |
| `continues copilot [n]` | Resume Nth Copilot session |
| `continues gemini [n]` | Resume Nth Gemini session |
| `continues opencode [n]` | Resume Nth OpenCode session |
| `continues resume <id>` | Resume specific session |

### Options

| Option | Description |
|--------|-------------|
| `--source <tool>` | Filter by source tool |
| `--limit <n>` | Limit results |
| `--target <tool>` | Cross-tool resume target |
| `--json` | Output as JSON |
| `--rebuild` | Force index rebuild |

---

## 🗂️ How It Works

**continues** automatically discovers and indexes sessions from:

| Tool | Session Location |
|------|------------------|
| Codex | `~/.codex/sessions/` |
| Claude | `~/.claude/projects/` |
| Copilot | `~/.copilot/session-state/` |
| Gemini | `~/.gemini/tmp/*/chats/` |
| OpenCode | `~/.local/share/opencode/storage/` |

The unified index lives at `~/.continues/sessions.jsonl` and auto-refreshes every 5 minutes.

---

## 🔧 Development

```bash
git clone https://github.com/yigitkonur/continues.git
cd continues
npm install
npm run build
npm link
```

---

## 📄 License

MIT © [Yigit Konur](https://github.com/yigitkonur)

---

<div align="center">

**Stop losing context. Start continuing.**

</div>

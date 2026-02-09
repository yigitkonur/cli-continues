<div align="center">

# cli-continues

**One command to resume any AI coding session.**

Codex • Claude • Copilot • Gemini • OpenCode

[![npm](https://img.shields.io/npm/v/cli-continues?color=cb0000&label=)](https://www.npmjs.com/package/cli-continues)
[![downloads](https://img.shields.io/npm/dm/cli-continues?color=cb0000&label=)](https://www.npmjs.com/package/cli-continues)

</div>

```bash
npm i -g cli-continues
```

---

### The Problem

Context is everything. You're deep in Claude, switch to Copilot, close terminal—gone.

### The Fix

```bash
continues
```

Pick any session. Resume in any tool. That's it.

---

## Usage

```bash
continues              # interactive picker
continues codex        # latest codex session
continues claude 2     # 2nd newest claude session
continues list         # show all
```

**Cross-tool handoff** — start in Claude, finish in Copilot:

```bash
continues resume <id> --target copilot
```

Your context travels with you.

---

## Commands

```
continues                    Interactive picker (default)
continues <tool> [n]         Resume Nth session from tool
continues list [--source x]  List sessions
continues resume <id>        Resume by ID
continues rebuild            Refresh index
```

Tools: `codex` `claude` `copilot` `gemini` `opencode`

---

## How it works

Indexes sessions from:

```
~/.codex/sessions/
~/.claude/projects/
~/.copilot/session-state/
~/.gemini/tmp/*/chats/
~/.local/share/opencode/storage/
```

Unified index at `~/.continues/sessions.jsonl`. Auto-refreshes.

---

## Install

```bash
npm i -g cli-continues
```

Requires Node 18+. Alias: `cont`

---

<div align="center">

MIT • [github.com/yigitkonur/cli-continues](https://github.com/yigitkonur/cli-continues)

</div>

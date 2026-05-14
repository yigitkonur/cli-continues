# Continues Relay

VS Code extension for [cli-continues](https://github.com/yigitkonur/cli-continues). Browse, preview, and resume AI coding sessions directly from the sidebar.

## Features

- **Session browser** — lists recent sessions across 16 supported tools (Claude, Codex, Copilot, Gemini, OpenCode, Droid, Cursor, Amp, Kiro, Crush, Cline, Roo Code, Kilo Code, Antigravity, Kimi, Qwen Code)
- **Search & filter** — free-text search across summary, repo, branch, and tool name
- **Handoff preview** — generates and opens the full markdown handoff document in the editor
- **Cross-tool resume** — relaunches a session in Codex or Claude via VS Code terminal
- **Bilingual UI** — English and Simplified Chinese, auto-detected or manually switched

## Prerequisites

The `continues` CLI must be installed and available on your `PATH`.

```bash
npm install -g cli-continues
```

If the binary is installed elsewhere, set the path in settings.

## Quick start

```bash
cd vscode-extension
pnpm install --no-lockfile
pnpm run compile
```

Open this folder in VS Code, press `F5`, and select **Run Continues Relay Extension**.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `continuesRelay.cliPath` | `string` | `"continues"` | Path to the `continues` binary |
| `continuesRelay.preset` | `enum` | `"standard"` | Handoff verbosity: `minimal`, `standard`, `verbose`, `full` |
| `continuesRelay.language` | `enum` | `"auto"` | Panel language: `auto`, `en`, `zh-CN` |

## Commands

| Command | Description |
|---------|-------------|
| `Continues Relay: Refresh Sessions` | Rebuild and reload the session list |
| `Continues Relay: Preview Handoff` | Generate and open a handoff markdown file |
| `Continues Relay: Resume in Codex` | Open a terminal and run `continues resume --in codex` |
| `Continues Relay: Resume in Claude` | Open a terminal and run `continues resume --in claude` |

## License

MIT — see [LICENSE](./LICENSE).

This extension embeds a subset of SVG icon paths from [Tabler Icons](https://tabler.io/icons) (MIT). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the full notice.

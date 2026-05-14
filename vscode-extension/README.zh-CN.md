# Continues Relay

[cli-continues](https://github.com/yigitkonur/cli-continues) 的 VS Code 扩展。在侧边栏中浏览、预览和接力 AI 编程会话。

## 功能

- **会话列表** — 展示 16 种工具的近期会话（Claude、Codex、Copilot、Gemini、OpenCode、Droid、Cursor、Amp、Kiro、Crush、Cline、Roo Code、Kilo Code、Antigravity、Kimi、Qwen Code）
- **搜索过滤** — 按摘要、仓库、分支、工具名自由搜索
- **Handoff 预览** — 在主编辑区打开完整的 markdown handoff 文档
- **跨工具接力** — 在 VS Code 终端中将会话接力到 Codex 或 Claude
- **双语界面** — 支持英文和简体中文，自动跟随 VS Code 语言或手动切换

## 前置条件

需要先安装 `continues` CLI 并确保在 `PATH` 中可用。

```bash
npm install -g cli-continues
```

如果安装在非标准路径，在设置中指定完整路径即可。

## 快速开始

```bash
cd vscode-extension
pnpm install --no-lockfile
pnpm run compile
```

在 VS Code 中打开此目录，按 `F5`，选择 **Run Continues Relay Extension**。

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `continuesRelay.cliPath` | `string` | `"continues"` | `continues` 可执行文件路径 |
| `continuesRelay.preset` | `enum` | `"standard"` | handoff 详细程度：`minimal`、`standard`、`verbose`、`full` |
| `continuesRelay.language` | `enum` | `"auto"` | 面板语言：`auto`、`en`、`zh-CN` |

## 命令

| 命令 | 说明 |
|------|------|
| `Continues Relay: Refresh Sessions` | 重建并刷新会话列表 |
| `Continues Relay: Preview Handoff` | 生成并打开 handoff markdown 文件 |
| `Continues Relay: Resume in Codex` | 打开终端执行 `continues resume --in codex` |
| `Continues Relay: Resume in Claude` | 打开终端执行 `continues resume --in claude` |

## 许可

MIT — 详见 [LICENSE](./LICENSE)。

本扩展内嵌了 [Tabler Icons](https://tabler.io/icons) 的部分 SVG 图标路径（MIT）。完整声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

# 帮助

## 会话列表为空

先在终端里确认 CLI 能正常运行：

```bash
continues list --json
```

如果 CLI 不在 `PATH` 中，在 VS Code 设置中将 `continuesRelay.cliPath` 设为绝对路径。

## 接力命令不生效

接力操作在 VS Code 终端中执行。请确保目标工具（`codex` 或 `claude`）已在当前终端环境中安装并登录。

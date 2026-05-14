# Support

## Sessions not loading

Verify the CLI works outside VS Code first:

```bash
continues list --json
```

If the binary is not on `PATH`, set `continuesRelay.cliPath` to the absolute path in VS Code settings.

## Resume commands not working

Resume runs in a VS Code terminal. Make sure the target tool (`codex` or `claude`) is installed and authenticated in the same shell environment.

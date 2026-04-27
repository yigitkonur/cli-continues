# Qwen Code

Accessed: 2026-04-15

## Documented Fact

- Default global root: `~/.qwen`
- Actual runtime-root override:
  - `QWEN_RUNTIME_DIR`
- Current session/chat root:
  - `<runtime-base>/projects/<sanitized-cwd>/chats/`
- Related runtime roots:
  - `<runtime-base>/tmp/<project-hash>/`
  - `<runtime-base>/history/<project-hash>/`
  - `<runtime-base>/debug/`
- Session file format: JSONL
- Filename behavior:
  - current recording service writes `<session-id>.jsonl`
- Session-ID location:
  - filename
  - each record also carries `sessionId`
- Record behavior:
  - each record carries `uuid`, `parentUuid`, `sessionId`, `timestamp`, `type`, `cwd`, and related payload fields
- Append/update behavior:
  - each record is appended immediately with `jsonl.writeLineSync`
  - conversation files are created once and then extended line-by-line

## Observed Example

- The current Qwen session service explicitly documents session files as JSONL and lists them from `getProjectDir()/chats`, not from a `QWEN_HOME` override root.

## Comparison Against `continues`

- Registry: `src/parsers/registry.ts` advertises `QWEN_HOME`.
- Parser: `src/parsers/qwen-code.ts` also uses `QWEN_HOME`.
- Upstream repo search found `QWEN_RUNTIME_DIR` but did not surface a live `QWEN_HOME` storage override.
- What still matches:
  - default root under `~/.qwen`
  - session files under `projects/<sanitized-cwd>/chats/*.jsonl`
- Risk: high because the env-var override currently documented by `continues` appears stale.

## Direct Access Recipe

- Session chat files:
  - `~/.qwen/projects/<sanitized-cwd>/chats/*.jsonl`
- Runtime override:
  - inspect `QWEN_RUNTIME_DIR`
- Related non-session runtime data:
  - `~/.qwen/tmp/<project-hash>/`
  - `~/.qwen/history/<project-hash>/`

## Sources

- Official repo code: https://github.com/QwenLM/qwen-code


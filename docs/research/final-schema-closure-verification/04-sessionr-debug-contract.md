# Sessionr And Debug Contract Closure Pass

## Summary

The strongest current first-party conclusion is that `sessionr --new --async` is not a deterministic created-session-ID recovery contract. The README and source support a job-first async contract, but the created session ID is not recovered in the async path the way it is in sync mode.

The current `continues` same-tool `--debug-prompt` rejection is coherent with the code that exists today, because native resume does not synthesize an outbound prompt. But that does not prove it is the best UX. First-party patterns support machine-readable orchestration and explicit next-action surfaces more strongly than plain text alone.

## New Confirmations

- `sessionr` is a structured automation CLI with `api_version`, `meta`, and `actions`
- sync and async write paths are materially different
- the local `continues` implementation matches its own semantics
- major first-party CLIs prefer structured automation output surfaces

## New Contradictions

- any deterministic-ID assumption for `sessionr --new --async`
- any claim that plain-text-only prompt debugging is the best-supported long-term contract

## Still Unresolved

- whether async new-session-ID recovery is a known bug, accepted tradeoff, or future work in `sessionr`
- the exact schema of a structured prompt-debug artifact for `continues`
- whether same-tool debug should hard-error or surface the native resume/action path instead

## URLs

- https://github.com/yigitkonur/cli-sessionr
- https://github.com/yigitkonur/cli-sessionr/blob/main/src/commands/send.ts
- https://github.com/yigitkonur/cli-sessionr/blob/main/src/commands/job.ts
- https://github.com/yigitkonur/cli-sessionr/blob/main/src/jobs.ts
- https://github.com/yigitkonur/cli-sessionr/blob/main/src/cli.ts
- https://github.com/yigitkonur/cli-sessionr/blob/main/README.md
- https://developers.openai.com/codex/noninteractive
- https://docs.anthropic.com/en/docs/claude-code/cli-reference
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- https://docs.github.com/en/copilot/how-tos/copilot-cli/steer-remotely

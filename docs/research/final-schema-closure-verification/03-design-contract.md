# Design Contract Closure Pass

## Summary

Current first-party evidence supports simplifying the human-facing handoff contract, but not collapsing the entire product into `default | full` as the only public axis. Major CLIs separate:

- human-readable output
- machine-readable output
- explicit session/history/inspection commands

So `default | full` can remain a useful human-facing simplification, but should not be treated as the only public model.

## New Confirmations

- Claude Code, Codex, and Copilot CLI all support structured machine-readable output separately from the default human-facing surface.
- First-party patterns support a separate inspection/history axis instead of only one detail ladder.
- Pointer metadata belongs early, but not as the dominant default payload.

## New Contradictions

- treating `default | full` as the whole public contract is too strong
- treating the pointer block as the universal leading payload is too strong
- treating plain-text prompt debugging as the sole long-term inspection shape is too strong

## Still Unresolved

- exact public API shape for the separate machine/inspection surface
- exact placement of the pointer block relative to the summary
- exact same-tool debug UX

## URLs

- https://code.claude.com/docs/en/cli-reference
- https://developers.openai.com/codex/cli/reference
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
- https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle
- https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices

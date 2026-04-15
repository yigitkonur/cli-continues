# Qwen Code

## Documented Facts

- First-party Qwen code shows the runtime base is `~/.qwen` by default, overridable via `QWEN_RUNTIME_DIR`.
- First-party storage code builds project directories under `<runtime-base>/projects/<sanitized-cwd>/`.
- First-party session code stores chats in a `chats/` folder and models chat records as append-only JSONL with `uuid`, `parentUuid`, `sessionId`, timestamps, message content, usage metadata, and tool-result metadata.
- A first-party issue asks for moving more chat/config/debug data into a workspace `.qwen` folder, which confirms the current runtime storage is still external enough to be worth surfacing.

## Observed Example

- `src/parsers/qwen-code.ts` matches the `projects/*/chats/*.jsonl` layout and reconstructs the main conversation path by walking `parentUuid`.

## Inference

- Qwen’s pointer block should highlight that the raw transcript is tree-structured JSONL, not a simple linear log. That tree property matters more than extra prose.

## Unresolved Uncertainty

- First-party Qwen code also uses a temp tree for checkpoints/history, and some comments still reference `tmp`; the parser’s current `projects/*/chats` assumption is supported by storage code, but the broader runtime layout is still evolving.

## Default-Mode Pointer Block

- `Session`: Qwen Code / `<session-id>`
- `Raw transcript`: `<runtime-base>/projects/<sanitized-cwd>/chats/<session-id>.jsonl`
- `Backend`: tree-structured JSONL
- `Volume`: `<record-count>` total records
- `Main path`: include `<main-path-message-count>` if cheap
- `Quick inspect`: `sed -n '1,12p' <chat>.jsonl`

## Full-Mode Pointer Block

- Everything from default mode
- `Tree note`: records branch via `uuid` and `parentUuid`; the visible chat is a reconstructed main path, not necessarily the full file
- `Record mix`: counts for `user`, `assistant`, `tool_result`, and `system`
- `Focused retrieval`:
  - `rg -n '"type":"user"|"type":"assistant"|"type":"tool_result"|"type":"system"' <chat>.jsonl`
  - `jq -c '{uuid,parentUuid,type,timestamp}' <chat>.jsonl | head -n 20`
- `Runtime note`: show the resolved runtime base and mention `QWEN_RUNTIME_DIR` when it is set

## Why This Is Feasible

- `continues` already parses the JSONL and reconstructs the main path.
- Record counts and main-path counts are cheap because the parser is already walking the record graph.

## Current `continues` Comparison

- Current handoff output flattens Qwen into recent conversation text and tool summaries, which hides the most important raw-storage fact: the source transcript is a branched record tree.

## Sources

- First-party repo code: `QwenLM/qwen-code` files `packages/core/src/config/storage.ts`, `packages/core/src/services/sessionService.ts`, and `packages/core/src/services/chatRecordingService.ts` (read 2026-04-15)
- First-party issue: https://github.com/QwenLM/qwen-code/issues/2396 (accessed 2026-04-15)
- Local parser: `src/parsers/qwen-code.ts` (read 2026-04-15)

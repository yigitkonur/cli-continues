# Amp

## Raw storage

- Documented fact:
  - Amp’s official manual documents threads, `amp threads continue`, handoffs, and JSON streaming modes.
  - The manual does not document an on-disk thread/transcript file path.
- Observed example:
  - Local thread files exist under `~/.local/share/amp/threads/T-*.json`.
  - Sampled thread JSON keys were `agentMode`, `created`, `env`, `id`, `messages`, `meta`, `nextMessageId`, and `v`.
  - Sampled message content kinds were only `text`.
- Inference:
  - Amp’s local thread JSON, at least in the observed samples, is chat-centric and not a rich raw tool-call log.
- Unresolved uncertainty:
  - The official manual says threads contain messages, context, and tool calls conceptually, but no first-party on-disk schema was found for how or whether those tool calls are persisted locally.

## Tool-call encoding

- Observed example:
  - No `tool_use`, `tool_result`, `toolCalls`, or non-text content parts were present in sampled local thread files.
- Documented fact:
  - Amp supports `--stream-json` and `--stream-json-input`, both line-oriented JSON protocols, but the manual does not connect those stream objects to the on-disk thread JSON format.
- Inference:
  - Tool-call fidelity may exist in runtime streams but not necessarily in the local thread file format.

## Write, edit, delete, search, MCP, shell

- Observed example:
  - Sampled thread JSON did not preserve raw write/edit/delete/search/shell events as separate structured entries.
- Inference:
  - `continues` should not promise exact tool activity from Amp unless a richer first-party storage source is identified.

## What `continues` abstracts away today

- `src/parsers/amp.ts` already emits no tool summaries and only lightly uses `usageLedger` if present.
- That conservative behavior matches the sampled local JSON better than a more aggressive parser would.
- The main risk is not over-normalization; it is lack of a documented source of exact tool names.

## Direct-access recipe

```bash
find ~/.local/share/amp/threads -type f -name '*.json' | head

jq -c '{id,topKeys:(keys|sort),messageShape:(.messages[0]|keys_unsorted),contentKinds:[.messages[0].content[]?.type]}' \
  ~/.local/share/amp/threads/T-*.json | head -n 1
```

## Sources

- Accessed 2026-04-15: https://ampcode.com/manual
- Observed locally on 2026-04-15: `~/.local/share/amp/threads/T-*.json`

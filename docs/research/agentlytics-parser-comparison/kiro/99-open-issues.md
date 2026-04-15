# Open Kiro issues for parser comparison

Last updated: 2026-04-15

## 1. Need a real current Kiro sample set

Missing artifacts:

- one current CLI SQLite session from `~/.kiro/`
- one current ACP session pair from `~/.kiro/sessions/cli/<id>.json` and `<id>.jsonl`
- one current IDE-private `.chat` file under `.../User/globalStorage/kiro.kiroagent/...`
- one current `workspace-sessions` sample if that subtree still exists

Why this matters:

- it is the only way to settle whether `continues` should target SQLite, ACP JSONL, IDE-private `.chat`, or multiple Kiro surfaces
- it would validate or falsify `agentlytics` assumptions around `executionId`, `metadata.workflow`, `context[]`, and tool-message layout

## 2. Resolve the CLI-vs-ACP relationship

Current first-party docs say both:

- normal chat is stored in a SQLite-backed database under `~/.kiro/`
- ACP persists sessions under `~/.kiro/sessions/cli/`
- interactive chat uses ACP internally

Open question:

- are these two layers for the same conversation, or different storage systems for different runtimes?

Impact:

- if they are dual layers, the parser likely needs two readers
- if ACP is now canonical for interactive chat, both current parsers are targeting the wrong surface

## 3. Decide whether Kiro support means CLI, IDE, or both

`continues` currently mixes:

- parser code aimed at an old IDE-like JSON store
- docs aimed at the current CLI/ACP public surface

Open question:

- should Kiro support be split into explicit variants, or should one variant be chosen as canonical?

Impact:

- without a product-surface decision, "Kiro support" will keep drifting between incompatible storage models

## 4. Tool fidelity is currently unsolved

Known facts:

- Kiro ACP documents `ToolCall` and `ToolCallUpdate`
- `agentlytics` preserves some raw tool messages but usually misses structured tool names/args
- `continues` emits no Kiro tool summaries at all

Open question:

- which Kiro surface gives the highest-fidelity tool record: ACP `.jsonl`, IDE `.chat`, or neither?

Impact:

- this determines whether Kiro can participate in accurate handoff summaries, tool analytics, and reconstruction of agent work

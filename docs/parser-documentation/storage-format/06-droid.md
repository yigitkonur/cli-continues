# Factory Droid

Accessed: 2026-04-15

## Documented Fact

- Officially documented local settings roots:
  - `~/.factory/settings.json`
  - `~/.factory/settings.local.json`
  - `<project>/.factory/settings.local.json`
- Officially documented session behavior:
  - `droid exec -s <id>` / `--session-id <id>` resumes an existing session
  - `cloudSessionSync` can mirror CLI sessions to Factory web or keep them local only
- Officially documented env/config items:
  - `FACTORY_API_KEY`
- No first-party storage-root env var was found for session transcripts.
- Officially documented related local storage:
  - `~/.factory/droids/`
  - `~/.factory/logs/`

## Observed Example

- Third-party tooling that parses current Droid usage expects a session tree under `~/.factory/sessions/` and specifically documents `--droid-dir /path/to/.factory/sessions`.
- That same tooling keys Droid discovery off `~/.factory/sessions/**/*.settings.json`, which is consistent with `continues` looking for companion `.settings.json` files beside session logs.

## Inference

- The current `continues` parser shape
  - `~/.factory/sessions/<workspace-slug>/<id>.jsonl`
  - sibling `<id>.settings.json`
  is plausible, but I did not find first-party documentation that proves the transcript path or the JSONL event schema.
- Session-ID location is only first-party documented at the CLI level today:
  - `-s/--session-id <id>`
  - the on-disk placement of that ID is still inferred, not documented.

## Unresolved Uncertainty

- Exact transcript root, format, and append/update behavior remain unverified from first-party sources.
- I did not find a first-party schema reference for `session_start`, `todo_state`, `compaction_state`, or the sibling `.settings.json` file.

## Comparison Against `continues`

- Registry/parser: `src/parsers/registry.ts` and `src/parsers/droid.ts` assume a concrete `.factory/sessions/...jsonl` event log model.
- Risk: high. The resume-by-ID concept is first-party, but the local transcript layout is still only indirectly corroborated.

## Direct Access Recipe

- First-party confirmed:
  - inspect `~/.factory/settings.json`
  - check whether `cloudSessionSync` is enabled
- Provisional local inspection path:
  - `~/.factory/sessions/`
  - look for `<id>.jsonl` with sibling `<id>.settings.json`

## Sources

- Official docs: https://docs.factory.ai/cli/configuration/settings
- Official docs: https://docs.factory.ai/cli/configuration/cli-reference
- Official docs: https://docs.factory.ai/cli/configuration/custom-droids
- Official docs: https://docs.factory.ai/cli/configuration/ide-integrations
- Third-party observed example: https://ayagmar.github.io/llm-usage-metrics/getting-started/

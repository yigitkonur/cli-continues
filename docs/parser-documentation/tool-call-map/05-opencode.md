# OpenCode

## Raw storage

- Documented fact:
  - The current official OpenCode repo stores session data in SQLite by default at `Global.Path.data/opencode.db`.
  - The same repo ships JSON-to-SQLite migration code from a legacy `storage/` tree containing `project/*.json`, `session/*/*.json`, `message/*/*.json`, `part/*/*.json`, `todo/*.json`, `permission/*.json`, and `session_share/*.json`.
  - Core SQLite tables are `session`, `message`, `part`, `todo`, `session_entry`, and `permission`.
- Observed example:
  - Local `~/.local/share/opencode/opencode.db` contains populated `session`, `message`, and `part` tables.
- Inference:
  - OpenCode has already standardized on a part-oriented SQLite backend, with the legacy JSON tree retained only for migration.
- Unresolved uncertainty:
  - None that materially affects tool-call mapping; the schema is explicit.

## Tool-call encoding

- Documented fact:
  - OpenCode stores tool activity as `part.data` rows with `type: "tool"`.
  - `ToolPart` fields are `callID`, exact `tool` name, and `state`.
  - `state` is a discriminated union:
    - `pending`: `input`, `raw`
    - `running`: `input`, optional `title`, optional `metadata`, `time.start`
    - `completed`: `input`, `output`, `title`, `metadata`, `time.start`, `time.end`, optional `attachments`
    - `error`: `input`, `error`, optional `metadata`, `time.start`, `time.end`
- Observed example:
  - Local tool-part names include `bash`, `webfetch`, `read`, `todowrite`, `grep`, and `apply_patch`.
  - Local completed tool parts contain `state.input` JSON and `state.output` text.
  - Local sessions also preserve `summary_additions`, `summary_deletions`, and `summary_files` in `session`.
- Inference:
  - OpenCode is one of the clearest upstream schemas in the entire tool list. Exact names, inputs, outputs, status, and timing are all present.

## Write, edit, delete, search, MCP, shell

- Documented fact:
  - Exact tool names are stored in `part.data.tool`.
  - The tool-state payload itself distinguishes successful completion vs error.
- Observed example:
  - Shell-like exact name: `bash`
  - Fetch-like exact name: `webfetch`
  - File read exact name: `read`
  - Patch/edit exact name: `apply_patch`
  - Search exact name: `grep`

## What `continues` abstracts away today

- `src/parsers/opencode.ts` currently reduces OpenCode tool activity to a session-level `Edit` summary derived from `summary_additions`, `summary_deletions`, and `summary_files`.
- It does not read `part` rows of `type: "tool"` at all.
- That means exact tool names, arguments, output/error placement, per-tool timing, and attachment metadata are all dropped even though upstream stores them cleanly.

## Direct-access recipe

```bash
sqlite3 ~/.local/share/opencode/opencode.db '.schema session' '.schema message' '.schema part'

sqlite3 ~/.local/share/opencode/opencode.db \
  "select json_extract(data,'$.tool') as tool,
          json_extract(data,'$.state.status') as status,
          json_extract(data,'$.state.input') as input,
          substr(json_extract(data,'$.state.output'),1,150) as output
   from part
   where json_extract(data,'$.type')='tool'
   limit 10;"
```

## Sources

- Accessed 2026-04-15: https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/storage/db.ts
- Accessed 2026-04-15: https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/storage/json-migration.ts
- Accessed 2026-04-15: https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/session.sql.ts
- Accessed 2026-04-15: https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/session/message-v2.ts
- Observed locally on 2026-04-15: `~/.local/share/opencode/opencode.db`

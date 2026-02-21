/**
 * Canonical tool names and derived SessionSource type.
 * Adding a new tool: add the name here, then the compiler surfaces every location that needs updating.
 */

/** Ordered list of all supported tool names — single source of truth */
export const TOOL_NAMES = Object.freeze([
  'claude',
  'codex',
  'copilot',
  'gemini',
  'opencode',
  'droid',
  'cursor',
] as const);

/** Source CLI tool — derived from TOOL_NAMES, never defined manually */
export type SessionSource = (typeof TOOL_NAMES)[number];

// ── Canonical Tool Name Sets ────────────────────────────────────────────────
// Used by all parsers to classify tool invocations consistently.
// Each set contains all known aliases for a tool category across every CLI.

/** Shell/command execution tools */
export const SHELL_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'bash',
  'terminal',
  'run_terminal_command',
  'exec_command',
  'shell_command',
  'Execute',
]);

/** File read tools */
export const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'ReadFile', 'read_file']);

/** File write/create tools */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'WriteFile', 'write_file', 'Create', 'create_file']);

/** File edit/patch tools */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'EditFile', 'edit_file', 'apply_diff', 'ApplyPatch']);

/** Search/grep tools */
export const GREP_TOOLS: ReadonlySet<string> = new Set(['Grep', 'grep', 'codebase_search']);

/** Glob/directory listing tools */
export const GLOB_TOOLS: ReadonlySet<string> = new Set(['Glob', 'glob', 'list_directory', 'file_search', 'LS']);

/** Web search tools */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'web_search']);

/** Web fetch tools */
export const FETCH_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'web_fetch']);

/** Subagent/task tools */
export const TASK_TOOLS: ReadonlySet<string> = new Set(['Task', 'task']);

/** Task output tools */
export const TASK_OUTPUT_TOOLS: ReadonlySet<string> = new Set(['TaskOutput']);

/** User interaction tools */
export const ASK_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'request_user_input']);

/** Tools to skip — internal bookkeeping, no useful handoff context */
export const SKIP_TOOLS: ReadonlySet<string> = new Set(['TaskStop', 'ExitPlanMode', 'TodoWrite']);

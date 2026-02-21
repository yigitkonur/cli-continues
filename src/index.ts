/**
 * continues — Public API
 *
 * Resume any AI coding session across Claude, Copilot, Gemini, Codex,
 * OpenCode, Droid, and Cursor.
 *
 * @example
 * ```ts
 * import { getAllSessions, extractContext, adapters } from 'continues';
 *
 * const sessions = await getAllSessions();
 * const ctx = await extractContext(sessions[0]);
 * console.log(ctx.markdown);
 * ```
 */

// ── Errors ───────────────────────────────────────────────────────────
export {
  ContinuesError,
  IndexError,
  ParseError,
  SessionNotFoundError,
  StorageError,
  ToolNotAvailableError,
  UnknownSourceError,
} from './errors.js';
// ── Logger ───────────────────────────────────────────────────────────
export type { LogLevel } from './logger.js';
export { getLogLevel, logger, setLogLevel } from './logger.js';

// ── Registry ─────────────────────────────────────────────────────────
export type { ToolAdapter } from './parsers/registry.js';
export { ALL_TOOLS, adapters, SOURCE_HELP } from './parsers/registry.js';
export type { ContentBlock, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from './types/content-blocks.js';
// ── Types ────────────────────────────────────────────────────────────
export type {
  ConversationMessage,
  HandoffOptions,
  SessionContext,
  SessionNotes,
  SessionSource,
  ToolCall,
  ToolSample,
  ToolUsageSummary,
  UnifiedSession,
} from './types/index.js';
export { TOOL_NAMES } from './types/tool-names.js';
export type {
  CanonicalFlagKey,
  FlagOccurrence,
  ForwardMapResult,
  ForwardResolution,
  HandoffForwardingOptions,
  ParsedForwardFlags,
} from './utils/forward-flags.js';
export { parseForwardFlags, resolveForwardingArgs } from './utils/forward-flags.js';
// ── Session Operations ───────────────────────────────────────────────
export {
  buildIndex,
  ensureDirectories,
  extractContext,
  findSession,
  formatSession,
  getAllSessions,
  getCachedContext,
  getSessionsBySource,
  indexNeedsRebuild,
  loadIndex,
  saveContext,
  sessionsToJsonl,
} from './utils/index.js';
// ── Markdown ─────────────────────────────────────────────────────────
export { generateHandoffMarkdown, getSourceLabels } from './utils/markdown.js';
// ── Resume ───────────────────────────────────────────────────────────
export {
  crossToolResume,
  getAvailableTools,
  getResumeCommand,
  nativeResume,
  resolveCrossToolForwarding,
  resume,
} from './utils/resume.js';

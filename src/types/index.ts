/**
 * Unified Session Types for CLI session tools
 */

// Import SessionSource locally (used by UnifiedSession below) and re-export
import type { SessionSource } from './tool-names.js';

// Re-export shared content block types
export type { ContentBlock, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from './content-blocks.js';
export { type SessionSource, TOOL_NAMES } from './tool-names.js';

/** Unified session metadata */
export interface UnifiedSession {
  /** Unique session identifier */
  id: string;
  /** Source CLI tool */
  source: SessionSource;
  /** Working directory of the session */
  cwd: string;
  /** Git repository (owner/repo format) */
  repo?: string;
  /** Git branch */
  branch?: string;
  /** Session summary/description */
  summary?: string;
  /** Number of conversation turns */
  lines: number;
  /** Session file size in bytes */
  bytes: number;
  /** Session creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
  /** Path to original session file/directory */
  originalPath: string;
  /** Model used in the session */
  model?: string;
}

/** Conversation message in normalized format */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
  toolCalls?: ToolCall[];
}

/** Tool call information */
export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
}

/** One-line concise summary of a single tool invocation */
export interface ToolSample {
  /** e.g. "$ npm test → exit 0" or "edit src/auth.ts (+5 -2)" */
  summary: string;
}

/** Aggregated tool usage: unique tool name + count + representative samples */
export interface ToolUsageSummary {
  /** Tool name (e.g. "Bash", "exec_command", "write_file", "github-mcp-server-list_issues") */
  name: string;
  /** Number of times this tool was invoked */
  count: number;
  /** Up to 3 representative samples */
  samples: ToolSample[];
}

/** Contextual session notes (reasoning highlights, token usage) */
export interface SessionNotes {
  /** Model used in the session (kept for backwards compatibility with parsers that set it here) */
  model?: string;
  /** Key reasoning/thinking highlights (max 10) */
  reasoning?: string[];
  /** Token usage statistics */
  tokenUsage?: { input: number; output: number };
  /** Narrative summary from compact/compaction messages */
  compactSummary?: string;
}

/** Extracted context for cross-tool continuation */
export interface SessionContext {
  session: UnifiedSession;
  /** Last N conversation turns */
  recentMessages: ConversationMessage[];
  /** Files modified in the session */
  filesModified: string[];
  /** Pending tasks extracted from conversation */
  pendingTasks: string[];
  /** Concise tool usage summaries grouped by tool name */
  toolSummaries: ToolUsageSummary[];
  /** Contextual notes from AI reasoning, model info, etc. */
  sessionNotes?: SessionNotes;
  /** Generated markdown for injection */
  markdown: string;
}

/** Options controlling handoff markdown generation */
export interface HandoffOptions {
  /** Delivery mode — inline embeds full markdown as CLI arg, reference points to file */
  mode: 'inline' | 'reference';
  /** Max bytes for the conversation section (default: 20000 inline, 40000 reference) */
  maxConversationBytes?: number;
}

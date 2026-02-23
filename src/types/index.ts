/**
 * Unified Session Types for CLI session tools
 */

// Import SessionSource locally (used by UnifiedSession below) and re-export
import type { SessionSource, ToolSampleCategory } from './tool-names.js';

// Re-export shared content block types
export type { ContentBlock, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from './content-blocks.js';
export { type SessionSource, type ToolSampleCategory, TOOL_NAMES } from './tool-names.js';

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
  /** Unique call ID for matching call → result (Anthropic-format sessions) */
  id?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  /** Whether the tool call succeeded. Absent when status is unknown. */
  success?: boolean;
}

// ── Structured Tool Sample Data ─────────────────────────────────────────────
// Discriminated union on `category`. Each tool type captures what matters.

export interface ShellSampleData {
  category: 'shell';
  command: string;
  exitCode?: number;
  /** Last N lines of stdout (joined with \n). Omitted if empty. */
  stdoutTail?: string;
  /** True when command exited non-zero or tool reported an error. */
  errored?: boolean;
}

export interface ReadSampleData {
  category: 'read';
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface WriteSampleData {
  category: 'write';
  filePath: string;
  isNewFile?: boolean;
  /** Unified diff capped at maxLines. If truncated, ends with "+N lines truncated". */
  diff?: string;
  diffStats?: { added: number; removed: number };
}

export interface EditSampleData {
  category: 'edit';
  filePath: string;
  /** Unified diff capped at maxLines. If truncated, ends with "+N lines truncated". */
  diff?: string;
  diffStats?: { added: number; removed: number };
}

export interface GrepSampleData {
  category: 'grep';
  pattern: string;
  targetPath?: string;
  matchCount?: number;
}

export interface GlobSampleData {
  category: 'glob';
  pattern: string;
  resultCount?: number;
}

export interface SearchSampleData {
  category: 'search';
  query: string;
}

export interface FetchSampleData {
  category: 'fetch';
  url: string;
  /** First 100 characters of fetched content. */
  resultPreview?: string;
}

export interface TaskSampleData {
  category: 'task';
  description: string;
  agentType?: string;
  /** First 100 characters of task result. */
  resultSummary?: string;
}

export interface AskSampleData {
  category: 'ask';
  /** Question text, capped at 80 characters. */
  question: string;
}

export interface McpSampleData {
  category: 'mcp';
  /** Full tool name including namespace (e.g. "mcp__github__list_issues"). */
  toolName: string;
  /** Truncated params string (each value capped at 100 chars). */
  params?: string;
  /** First 100 characters of tool result. */
  result?: string;
}

/**
 * Discriminated union of all structured tool sample types.
 * The `category` field is the discriminant — use `switch(data.category)` for narrowing.
 */
export type StructuredToolSample =
  | ShellSampleData
  | ReadSampleData
  | WriteSampleData
  | EditSampleData
  | GrepSampleData
  | GlobSampleData
  | SearchSampleData
  | FetchSampleData
  | TaskSampleData
  | AskSampleData
  | McpSampleData;

/** One-line concise summary of a single tool invocation */
export interface ToolSample {
  /** e.g. "$ npm test → exit 0" or "edit src/auth.ts (+5 -2)" */
  summary: string;
  /** Structured data for rich rendering. Absent for legacy/not-yet-updated parsers. */
  data?: StructuredToolSample;
}

/** Aggregated tool usage: unique tool name + count + representative samples */
export interface ToolUsageSummary {
  /** Tool name (e.g. "Bash", "exec_command", "write_file", "github-mcp-server-list_issues") */
  name: string;
  /** Number of times this tool was invoked */
  count: number;
  /** Number of invocations that ended in error */
  errorCount?: number;
  /** Up to N representative samples (N varies by category) */
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

/**
 * Unified Session Types for CLI session tools
 */

// Import SessionSource locally (used by UnifiedSession below) and re-export
import type { SessionSource } from './tool-names.js';

// Re-export shared content block types
export type { ContentBlock, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from './content-blocks.js';
export { isSessionSource, type SessionSource, TOOL_NAMES, type ToolSampleCategory } from './tool-names.js';

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
  /** Git commit SHA when the source tool records it */
  gitSha?: string;
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

/** Options for session discovery/indexing. Parsers may ignore unsupported filters. */
export interface SessionParseOptions {
  /** Restrict discovery to sessions matching this working directory when the storage layout supports it. */
  cwd?: string;
  /** Stop after collecting this many sessions when the parser can do so without changing sort semantics. */
  limit?: number;
  /** Favor fast picker/list metadata over exact counts or full timestamp scans. */
  lightweight?: boolean;
}

/** Conversation message in normalized format */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
  toolCalls?: ToolCall[];
  /** Source-tool message identifier, when available */
  sourceId?: string;
  /** Source-tool parent message identifier, when available */
  sourceParentId?: string;
  /** True when the message is useful metadata rather than user-visible conversation */
  isMeta?: boolean;
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
  /** Source-tool metadata such as exit code, truncation state, timing, or output path. */
  metadata?: Record<string, unknown>;
}

export type SessionEventKind =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'lifecycle'
  | 'reasoning'
  | 'metadata'
  | 'warning';

export interface SessionEvent {
  kind: SessionEventKind;
  sequence: number;
  timestamp?: Date;
  role?: ConversationMessage['role'];
  content?: string;
  id?: string;
  sourceId?: string;
  sourceParentId?: string;
  toolName?: string;
  toolCallId?: string;
  status?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  filePaths?: string[];
  metadata?: Record<string, unknown>;
  isFinalAnswer?: boolean;
  isMeta?: boolean;
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
  /** First 200 chars of error output when errored. */
  errorMessage?: string;
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
  /** First 200 chars of error text when the write failed. */
  errorMessage?: string;
}

export interface EditSampleData {
  category: 'edit';
  filePath: string;
  /** Unified diff capped at maxLines. If truncated, ends with "+N lines truncated". */
  diff?: string;
  diffStats?: { added: number; removed: number };
  /** First 200 chars of error text when the edit failed. */
  errorMessage?: string;
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
  /** Number of results returned, if parseable. */
  resultCount?: number;
  /** First 100 characters of the search result. */
  resultPreview?: string;
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

export interface ReasoningSampleData {
  category: 'reasoning';
  /** Full tool name (e.g. "mcp__crash-think-tool__crash"). */
  toolName: string;
  /** Reasoning step number, if available. */
  stepNumber?: number;
  /** The thought/reasoning text, truncated per config. */
  thought?: string;
  /** Expected or actual outcome. */
  outcome?: string;
  /** Planned next action (string or stringified object). */
  nextAction?: string;
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
  | McpSampleData
  | ReasoningSampleData;

/** One-line concise summary of a single tool invocation */
export interface ToolSample {
  /** e.g. "$ npm test → exit 0" or "edit src/auth.ts (+5 -2)" */
  summary: string;
  /** Structured data for rich rendering. Absent for legacy/not-yet-updated parsers. */
  data?: StructuredToolSample;
  /** Source event id this sample came from, when available. */
  sourceEventId?: string;
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
  /** Source event ids represented by this grouped summary, when available. */
  sourceEventIds?: string[];
}

/** Result from a subagent/task invocation */
export interface SubagentResult {
  taskId: string;
  description: string;
  status: 'completed' | 'killed' | 'error';
  /** Final text output from the subagent */
  result?: string;
  /** How many tools the subagent used */
  toolCallCount: number;
}

/** A single reasoning/thinking step captured during the session */
export interface ReasoningStep {
  stepNumber: number;
  totalSteps: number;
  /** Purpose category: 'analysis', 'decision', etc. */
  purpose: string;
  thought: string;
  outcome: string;
  nextAction: string;
}

/** Contextual session notes (reasoning highlights, token usage) */
export interface SessionNotes {
  /** Model used in the session (kept for backwards compatibility with parsers that set it here) */
  model?: string;
  /** Key reasoning/thinking highlights (max 10) */
  reasoning?: string[];
  /** Token usage statistics */
  tokenUsage?: { input: number; output: number };
  /** Cache token breakdown (prompt caching) */
  cacheTokens?: { creation: number; read: number };
  /** Tokens spent on extended thinking / chain-of-thought */
  thinkingTokens?: number;
  /** Wall-clock time the AI assistant was actively working (ms) */
  activeTimeMs?: number;
  /** Narrative summary from compact/compaction messages */
  compactSummary?: string;
  /** Results from subagent/task invocations */
  subagentResults?: SubagentResult[];
  /** Sequential reasoning/thinking steps captured during the session */
  reasoningSteps?: ReasoningStep[];
  /** External tool results (MCP, plugins) with size and preview */
  externalToolResults?: Array<{ name: string; sizeBytes: number; preview: string }>;
  /** Tool-specific lifecycle events such as turn start/abort/complete. */
  lifecycle?: Array<{ type: string; timestamp?: string; message?: string; metadata?: Record<string, unknown> }>;
  /** Bootstrap/environment details that should not be mixed into conversation text. */
  bootstrap?: Array<{ type: string; content: string; timestamp?: string; metadata?: Record<string, unknown> }>;
  /** Raw source metadata retained for parser fidelity but not rendered verbosely by default. */
  sourceMetadata?: Record<string, unknown>;
  /** Snapshot metadata such as Claude file-history-snapshot records. */
  fileHistorySnapshots?: Array<{ timestamp?: string; cwd?: string; metadata?: Record<string, unknown> }>;
  /** Pointer to raw source data, redacted when rendered. */
  rawAccess?: { kind: 'file' | 'directory' | 'sqlite'; path: string; redacted?: boolean };
  /** Known parser fidelity limits or downgraded source records. */
  fidelityWarnings?: string[];
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
  /** Chronological high-fidelity activity stream, when the parser can provide it. */
  timeline?: SessionEvent[];
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

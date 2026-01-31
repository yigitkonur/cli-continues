/**
 * Unified Session Types for Codex, Claude, Copilot, Gemini, and OpenCode CLIs
 */

/** Source CLI tool */
export type SessionSource = 'codex' | 'claude' | 'copilot' | 'gemini' | 'opencode';

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
  role: 'user' | 'assistant' | 'system' | 'tool';
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

/** Extracted context for cross-tool continuation */
export interface SessionContext {
  session: UnifiedSession;
  /** Last N conversation turns */
  recentMessages: ConversationMessage[];
  /** Files modified in the session */
  filesModified: string[];
  /** Pending tasks extracted from conversation */
  pendingTasks: string[];
  /** Generated markdown for injection */
  markdown: string;
}

/** Session parser interface - each CLI implements this */
export interface SessionParser {
  /** Check if this parser can handle the given path */
  canParse(path: string): boolean;
  /** Parse sessions from the default location */
  parseAll(): Promise<UnifiedSession[]>;
  /** Extract full context from a session */
  extractContext(session: UnifiedSession): Promise<SessionContext>;
}

/** Resume options */
export interface ResumeOptions {
  /** Session to resume */
  session: UnifiedSession;
  /** Target CLI tool */
  target: SessionSource;
  /** Whether to use native resume (same tool) */
  useNative: boolean;
}

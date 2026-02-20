import chalk from 'chalk';
import type { SessionSource, UnifiedSession, SessionContext } from '../types/index.js';
import { parseClaudeSessions, extractClaudeContext } from './claude.js';
import { parseCodexSessions, extractCodexContext } from './codex.js';
import { parseCopilotSessions, extractCopilotContext } from './copilot.js';
import { parseGeminiSessions, extractGeminiContext } from './gemini.js';
import { parseOpenCodeSessions, extractOpenCodeContext } from './opencode.js';
import { parseDroidSessions, extractDroidContext } from './droid.js';
import { parseCursorSessions, extractCursorContext } from './cursor.js';

/**
 * Adapter interface — single contract for all supported CLI tools.
 * To add a new tool, create its parser and add an entry here.
 */
export interface ToolAdapter {
  /** Unique identifier — must match a member of the SessionSource union */
  name: SessionSource;
  /** Human-readable label (e.g. "Claude Code") */
  label: string;
  /** Chalk color function for TUI display */
  color: (s: string) => string;
  /** Storage directory path (for help text) */
  storagePath: string;
  /** CLI binary name for availability checks and spawning */
  binaryName: string;
  /** Discover and index all sessions */
  parseSessions: () => Promise<UnifiedSession[]>;
  /** Extract full context for cross-tool handoff */
  extractContext: (session: UnifiedSession) => Promise<SessionContext>;
  /** CLI args to resume a session natively */
  nativeResumeArgs: (session: UnifiedSession) => string[];
  /** CLI args to start with a handoff prompt */
  crossToolArgs: (prompt: string, cwd: string) => string[];
  /** Display string for the native resume command */
  resumeCommandDisplay: (session: UnifiedSession) => string;
}

/**
 * Central registry — single source of truth for all supported tools.
 * Insertion order determines display order in the TUI.
 */
const _adapters: Record<string, ToolAdapter> = {};

function register(adapter: ToolAdapter): void {
  _adapters[adapter.name] = adapter;
}

// ── Claude Code ──────────────────────────────────────────────────────
register({
  name: 'claude',
  label: 'Claude Code',
  color: chalk.blue,
  storagePath: '~/.claude/projects/',
  binaryName: 'claude',
  parseSessions: parseClaudeSessions,
  extractContext: extractClaudeContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `claude --resume ${s.id}`,
});

// ── Codex CLI ────────────────────────────────────────────────────────
register({
  name: 'codex',
  label: 'Codex CLI',
  color: chalk.magenta,
  storagePath: '~/.codex/sessions/',
  binaryName: 'codex',
  parseSessions: parseCodexSessions,
  extractContext: extractCodexContext,
  nativeResumeArgs: (s) => ['-c', `experimental_resume=${s.originalPath}`],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `codex -c experimental_resume="${s.originalPath}"`,
});

// ── GitHub Copilot CLI ───────────────────────────────────────────────
register({
  name: 'copilot',
  label: 'GitHub Copilot CLI',
  color: chalk.green,
  storagePath: '~/.copilot/session-state/',
  binaryName: 'copilot',
  parseSessions: parseCopilotSessions,
  extractContext: extractCopilotContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => ['-i', prompt],
  resumeCommandDisplay: (s) => `copilot --resume ${s.id}`,
});

// ── Gemini CLI ───────────────────────────────────────────────────────
register({
  name: 'gemini',
  label: 'Gemini CLI',
  color: chalk.cyan,
  storagePath: '~/.gemini/tmp/*/chats/',
  binaryName: 'gemini',
  parseSessions: parseGeminiSessions,
  extractContext: extractGeminiContext,
  nativeResumeArgs: () => ['--continue'],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: () => `gemini --continue`,
});

// ── OpenCode ─────────────────────────────────────────────────────────
register({
  name: 'opencode',
  label: 'OpenCode',
  color: chalk.yellow,
  storagePath: '~/.local/share/opencode/storage/',
  binaryName: 'opencode',
  parseSessions: parseOpenCodeSessions,
  extractContext: extractOpenCodeContext,
  nativeResumeArgs: (s) => ['--session', s.id],
  crossToolArgs: (prompt) => ['--prompt', prompt],
  resumeCommandDisplay: (s) => `opencode --session ${s.id}`,
});

// ── Factory Droid ────────────────────────────────────────────────────
register({
  name: 'droid',
  label: 'Factory Droid',
  color: chalk.red,
  storagePath: '~/.factory/sessions/',
  binaryName: 'droid',
  parseSessions: parseDroidSessions,
  extractContext: extractDroidContext,
  nativeResumeArgs: (s) => ['-s', s.id],
  crossToolArgs: (prompt) => ['exec', prompt],
  resumeCommandDisplay: (s) => `droid -s ${s.id}`,
});

// ── Cursor AI ────────────────────────────────────────────────────────
register({
  name: 'cursor',
  label: 'Cursor AI',
  color: chalk.blueBright,
  storagePath: '~/.cursor/projects/*/agent-transcripts/',
  binaryName: 'cursor',
  parseSessions: parseCursorSessions,
  extractContext: extractCursorContext,
  nativeResumeArgs: (s) => [s.cwd],
  crossToolArgs: (_prompt, cwd) => [cwd],
  resumeCommandDisplay: (s) => `cursor ${s.cwd}`,
});

// ── Exports ──────────────────────────────────────────────────────────

/** Type-safe adapter lookup */
export const adapters = _adapters as Record<SessionSource, ToolAdapter>;

/** Ordered list of all tool names */
export const ALL_TOOLS: SessionSource[] = Object.keys(adapters) as SessionSource[];

/** Formatted help string for --source options */
export const SOURCE_HELP = `Filter by source (${ALL_TOOLS.join(', ')})`;

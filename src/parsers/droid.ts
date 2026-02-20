import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { UnifiedSession, SessionContext, ConversationMessage, ToolUsageSummary, SessionNotes } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { SummaryCollector, shellSummary, fileSummary, grepSummary, globSummary, mcpSummary, subagentSummary, withResult, truncate } from '../utils/tool-summarizer.js';
import { cwdFromSlug } from '../utils/slug.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';

const DROID_SESSIONS_DIR = path.join(homeDir(), '.factory', 'sessions');

/** Content block types inside Droid message.content[] */
interface DroidContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  // tool_use fields
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result fields
  tool_use_id?: string;
  content?: string;
}

/** Droid JSONL event: session_start */
interface DroidSessionStart {
  type: 'session_start';
  id: string;
  title: string;
  sessionTitle: string;
  owner?: string;
  version?: number;
  cwd: string;
  isSessionTitleManuallySet?: boolean;
  sessionTitleAutoStage?: string;
}

/** Droid JSONL event: message */
interface DroidMessageEvent {
  type: 'message';
  id: string;
  timestamp: string;
  parentId?: string;
  message: {
    role: 'user' | 'assistant';
    content: DroidContentBlock[];
  };
}

/** Droid JSONL event: todo_state */
interface DroidTodoState {
  type: 'todo_state';
  id: string;
  timestamp: string;
  todos: { todos: string } | string;
  messageIndex?: number;
}

/** Droid JSONL event: compaction_state */
interface DroidCompactionState {
  type: 'compaction_state';
  id: string;
  timestamp: string;
  summaryText?: string;
  summaryTokens?: number;
  summaryKind?: string;
  anchorMessage?: string;
  removedCount?: number;
  systemInfo?: unknown;
}

/** Union of all Droid JSONL events */
type DroidEvent = DroidSessionStart | DroidMessageEvent | DroidTodoState | DroidCompactionState;

/** Companion .settings.json schema */
interface DroidSettings {
  assistantActiveTimeMs?: number;
  model?: string;
  reasoningEffort?: string;
  interactionMode?: string;
  autonomyMode?: string;
  providerLock?: string;
  providerLockTimestamp?: string;
  apiProviderLock?: string;
  specModeReasoningEffort?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    thinkingTokens?: number;
  };
}

/**
 * Find all Droid session JSONL files.
 * Structure: ~/.factory/sessions/<workspace-slug>/<uuid>.jsonl
 */
async function findSessionFiles(): Promise<string[]> {
  const files: string[] = [];

  if (!fs.existsSync(DROID_SESSIONS_DIR)) {
    return files;
  }

  try {
    const workspaceDirs = fs.readdirSync(DROID_SESSIONS_DIR, { withFileTypes: true });
    for (const dir of workspaceDirs) {
      if (!dir.isDirectory()) continue;
      const wsPath = path.join(DROID_SESSIONS_DIR, dir.name);
      try {
        const entries = fs.readdirSync(wsPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push(path.join(wsPath, entry.name));
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }
  } catch {
    // Skip if base dir can't be read
  }

  return files;
}

/**
 * Read companion .settings.json for a session
 */
function readSettings(jsonlPath: string): DroidSettings | null {
  const settingsPath = jsonlPath.replace(/\.jsonl$/, '.settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as DroidSettings;
    }
  } catch {
    // Skip unreadable settings
  }
  return null;
}

/**
 * Parse session metadata from session_start event and first user message
 */
async function parseSessionInfo(filePath: string): Promise<{
  sessionStart: DroidSessionStart | null;
  firstUserMessage: string;
  firstTimestamp: string;
  lastTimestamp: string;
}> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let sessionStart: DroidSessionStart | null = null;
    let firstUserMessage = '';
    let firstTimestamp = '';
    let lastTimestamp = '';
    let linesRead = 0;

    rl.on('line', (line) => {
      linesRead++;
      if (linesRead > 100) {
        rl.close();
        stream.close();
        return;
      }

      try {
        const parsed = JSON.parse(line) as DroidEvent;

        if (parsed.type === 'session_start' && !sessionStart) {
          sessionStart = parsed;
        }

        if (parsed.type === 'message') {
          const msg = parsed as DroidMessageEvent;
          if (msg.timestamp) {
            if (!firstTimestamp) firstTimestamp = msg.timestamp;
            lastTimestamp = msg.timestamp;
          }

          if (!firstUserMessage && msg.message.role === 'user') {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                // Skip system-injected content (system reminders, permissions, etc.)
                if (!block.text.startsWith('<') && !block.text.startsWith('/') && !block.text.includes('Session Handoff')) {
                  firstUserMessage = block.text;
                  break;
                }
              }
            }
          }
        }
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => resolve({ sessionStart, firstUserMessage, firstTimestamp, lastTimestamp }));
    rl.on('error', () => resolve({ sessionStart: null, firstUserMessage: '', firstTimestamp: '', lastTimestamp: '' }));
  });
}

/**
 * Count lines in a JSONL file
 */
async function getLineCount(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    let lines = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', () => lines++);
    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve(0));
  });
}

/**
 * Parse all Droid sessions
 */
export async function parseDroidSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const { sessionStart, firstUserMessage, firstTimestamp, lastTimestamp } = await parseSessionInfo(filePath);
      if (!sessionStart) continue;

      const fileStats = fs.statSync(filePath);
      const lines = await getLineCount(filePath);
      const settings = readSettings(filePath);

      // Derive cwd from session_start event or from workspace slug
      const workspaceSlug = path.basename(path.dirname(filePath));
      const cwd = sessionStart.cwd || cwdFromSlug(workspaceSlug);

      const summary = cleanSummary(firstUserMessage);

      const createdAt = firstTimestamp ? new Date(firstTimestamp) : fileStats.birthtime;
      const updatedAt = lastTimestamp ? new Date(lastTimestamp) : fileStats.mtime;

      sessions.push({
        id: sessionStart.id,
        source: 'droid',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines,
        bytes: fileStats.size,
        createdAt,
        updatedAt,
        originalPath: filePath,
        summary: summary || sessionStart.sessionTitle || undefined,
        model: settings?.model,
      });
    } catch {
      // Skip files we can't parse
    }
  }

  return sessions
    .filter(s => s.lines > 1) // Skip empty sessions (session_start only)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Read all events from a Droid session JSONL
 */
async function readAllEvents(filePath: string): Promise<DroidEvent[]> {
  return new Promise((resolve) => {
    const events: DroidEvent[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        events.push(JSON.parse(line) as DroidEvent);
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => resolve(events));
    rl.on('error', () => resolve(events));
  });
}

/** Tools to skip — internal bookkeeping, not useful for handoff context */
const DROID_SKIP_TOOLS = new Set(['TodoWrite']);

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector.
 *
 * Droid uses Anthropic-style tool_use/tool_result content blocks.
 * Known tools: Create, Read, Edit, Execute, Bash, ApplyPatch, LS, Grep, Glob,
 * plus MCP tools (name contains ___ or -).
 */
function extractToolData(events: DroidEvent[]): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector();
  const toolResultMap = new Map<string, string>();

  // First pass: collect all tool_result blocks
  for (const event of events) {
    if (event.type !== 'message') continue;
    const msg = event as DroidMessageEvent;
    for (const block of msg.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id && block.content) {
        toolResultMap.set(block.tool_use_id, block.content.slice(0, 100));
      }
    }
  }

  // Second pass: process tool_use blocks
  for (const event of events) {
    if (event.type !== 'message') continue;
    const msg = event as DroidMessageEvent;
    if (msg.message.role !== 'assistant') continue;

    for (const block of msg.message.content) {
      if (block.type !== 'tool_use' || !block.name) continue;

      const name = block.name;
      if (DROID_SKIP_TOOLS.has(name)) continue;

      const input = block.input || {};
      const result = block.id ? toolResultMap.get(block.id) : undefined;
      const fp = (input.file_path as string) || (input.path as string) || '';

      if (name === 'Create') {
        collector.add('write_file', fileSummary('write', fp, undefined, true), fp, true);
      } else if (name === 'Read') {
        collector.add('read_file', fileSummary('read', fp), fp);
      } else if (name === 'Edit' || name === 'ApplyPatch') {
        collector.add('edit_file', withResult(fileSummary('edit', fp), result), fp, true);
      } else if (name === 'Execute' || name === 'Bash') {
        const cmd = (input.command as string) || (input.cmd as string) || '';
        collector.add('shell', shellSummary(cmd, result));
      } else if (name === 'Grep' || name === 'grep') {
        collector.add('Grep', grepSummary((input.pattern as string) || '', (input.path as string) || ''));
      } else if (name === 'Glob' || name === 'glob') {
        collector.add('Glob', globSummary((input.pattern as string) || ''));
      } else if (name === 'LS') {
        const dir = (input.directory_path as string) || (input.path as string) || '';
        collector.add('LS', withResult(`ls ${truncate(dir, 80)}`, result));
      } else if (name.includes('___') || name.includes('-')) {
        // MCP tools (e.g. context7___query-docs)
        collector.add(name, mcpSummary(name, JSON.stringify(input).slice(0, 100), result));
      } else {
        collector.add(name, withResult(`${name}(${JSON.stringify(input).slice(0, 100)})`, result));
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes: model info, token usage, reasoning/thinking highlights
 */
function extractSessionNotes(events: DroidEvent[], settings: DroidSettings | null): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  if (settings?.model) notes.model = settings.model;
  if (settings?.tokenUsage) {
    notes.tokenUsage = {
      input: settings.tokenUsage.inputTokens || 0,
      output: settings.tokenUsage.outputTokens || 0,
    };
  }

  // Extract thinking blocks as reasoning highlights
  for (const event of events) {
    if (event.type !== 'message') continue;
    const msg = event as DroidMessageEvent;
    if (msg.message.role !== 'assistant') continue;

    for (const block of msg.message.content) {
      if (block.type === 'thinking' && reasoning.length < 5) {
        const text = block.thinking || '';
        if (text.length > 20) {
          const firstLine = text.split(/[.\n]/)[0]?.trim();
          if (firstLine) reasoning.push(truncate(firstLine, 200));
        }
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Extract pending tasks from the most recent todo_state event
 */
function extractPendingTasks(events: DroidEvent[]): string[] {
  const tasks: string[] = [];

  // Find the last todo_state event
  let lastTodo: DroidTodoState | null = null;
  for (const event of events) {
    if (event.type === 'todo_state') {
      lastTodo = event as DroidTodoState;
    }
  }

  if (!lastTodo) return tasks;

  const todosText = typeof lastTodo.todos === 'string' ? lastTodo.todos : lastTodo.todos?.todos || '';
  if (!todosText) return tasks;

  // Parse todo lines: "1. [in_progress] Do something" or "2. [pending] Do other thing"
  for (const line of todosText.split('\n')) {
    const match = line.match(/^\d+\.\s*\[(in_progress|pending)\]\s+(.+)/);
    if (match && tasks.length < 5) {
      tasks.push(match[2].trim());
    }
  }

  return tasks;
}

/**
 * Extract context from a Droid session for cross-tool continuation
 */
export async function extractDroidContext(session: UnifiedSession): Promise<SessionContext> {
  const events = await readAllEvents(session.originalPath);
  const settings = readSettings(session.originalPath);

  const { summaries: toolSummaries, filesModified } = extractToolData(events);
  const sessionNotes = extractSessionNotes(events, settings);
  const pendingTasks = extractPendingTasks(events);

  // Collect conversation messages (text content only — skip tool_use/tool_result noise)
  const recentMessages: ConversationMessage[] = [];

  for (const event of events) {
    if (event.type !== 'message') continue;
    const msg = event as DroidMessageEvent;

    const textParts: string[] = [];
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        // Skip system-injected content
        if (!block.text.startsWith('<system-reminder>') && !block.text.startsWith('<permissions')) {
          textParts.push(block.text);
        }
      }
    }

    const text = textParts.join('\n').trim();
    if (!text) continue;

    recentMessages.push({
      role: msg.message.role === 'user' ? 'user' : 'assistant',
      content: text,
      timestamp: msg.timestamp ? new Date(msg.timestamp) : undefined,
    });
  }

  const trimmed = recentMessages.slice(-10);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
  );

  return {
    session: sessionNotes?.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

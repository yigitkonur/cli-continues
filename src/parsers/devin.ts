/**
 * Devin CLI parser.
 *
 * Devin CLI stores sessions in a SQLite database at
 * `~/.local/share/devin/cli/sessions.db` (the `cli-next` install channel keeps
 * its own `sessions.db` sibling). Layout:
 *
 *   sessions       id, working_directory, model, created_at, last_activity_at,
 *                  title, main_chain_id, hidden
 *   message_nodes  conversation tree — node_id/parent_node_id chain per
 *                  session; chat_message is a JSON blob
 *                  { message_id, role: user|assistant|tool|system, content,
 *                  tool_calls[], metadata }
 *
 * `sessions.main_chain_id` points at the tip of the active conversation
 * branch; walking parent_node_id links to the root yields the chronological
 * transcript. Tool results arrive as separate `role: "tool"` nodes with no
 * call-id linkage, so they are paired with the preceding assistant message's
 * tool_calls in order.
 *
 * Read-only: this parser never writes to the database.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionEvent,
  SessionNotes,
  SessionParseOptions,
  ToolCall,
  UnifiedSession,
} from '../types/index.js';
import type { DevinChatMessage, DevinMessageNodeRow, DevinToolCall } from '../types/schemas.js';
import { DevinChatMessageSchema, DevinMessageNodeRowSchema, DevinSessionRowSchema } from '../types/schemas.js';
import { isSystemContent } from '../utils/content.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { classifyToolName, type ToolSampleCategory } from '../types/tool-names.js';
import {
  fetchSummary,
  fileSummary,
  globSummary,
  grepSummary,
  mcpSummary,
  searchSummary,
  shellSummary,
  subagentSummary,
  SummaryCollector,
  truncate,
} from '../utils/tool-summarizer.js';

const require = createRequire(import.meta.url);

const DEVIN_SOURCE = 'devin' as const;
const DEVIN_DB_FILE = 'sessions.db';
/** Install channels that keep their own sessions.db, newest-first. */
const DEVIN_INSTALL_DIRS = ['cli', 'cli-next'] as const;
/** Guard against pathological trees when walking the parent chain. */
const MAX_CHAIN_DEPTH = 20_000;

interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

interface DatabaseSyncConstructor {
  new (location: string, options?: { readOnly?: boolean }): SqliteDatabase;
}

function getDatabaseSyncConstructor(): DatabaseSyncConstructor | undefined {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
    return sqlite.DatabaseSync;
  } catch (err) {
    logger.debug('devin: node:sqlite is unavailable', err);
    return undefined;
  }
}

/**
 * Resolve candidate sessions.db paths.
 * `DEVIN_CLI_HOME` overrides the base directory (fixtures, sandboxed installs);
 * otherwise both install channels under the XDG data dir are considered.
 */
function getDevinDbPaths(): string[] {
  if (process.env.DEVIN_CLI_HOME) {
    return [path.join(process.env.DEVIN_CLI_HOME, DEVIN_DB_FILE)];
  }
  const dataRoot = process.env.XDG_DATA_HOME || path.join(homeDir(), '.local', 'share');
  const base = path.join(dataRoot, 'devin');
  return DEVIN_INSTALL_DIRS.map((dir) => path.join(base, dir, DEVIN_DB_FILE)).filter((p) => fs.existsSync(p));
}

function openReadOnlyDatabase(dbPath: string): SqliteDatabase | undefined {
  const DatabaseSync = getDatabaseSyncConstructor();
  if (!DatabaseSync) return undefined;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    logger.debug('devin: failed to open SQLite database read-only', dbPath, err);
    return undefined;
  }
}

function closeDatabase(db: SqliteDatabase, dbPath: string): void {
  try {
    db.close();
  } catch (err) {
    logger.debug('devin: failed to close SQLite database', dbPath, err);
  }
}

/** Devin stores unix seconds; tolerate millisecond values defensively. */
function normalizeTimestamp(value: number | undefined | null): Date | undefined {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return undefined;
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseChatMessage(raw: string | null | undefined): DevinChatMessage | undefined {
  if (!raw) return undefined;
  try {
    const result = DevinChatMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch (err) {
    logger.debug('devin: failed to parse chat_message blob', err);
    return undefined;
  }
}

/** Map Devin tool names onto the shared tool categories. */
function classifyDevinToolName(name: string): ToolSampleCategory | undefined {
  switch (name) {
    case 'exec':
      return 'shell';
    case 'find_file_by_name':
      return 'glob';
    case 'run_subagent':
      return 'task';
    default:
      return classifyToolName(name);
  }
}

interface DevinSessionQueryRow {
  id: string;
  working_directory: string | undefined;
  model: string | undefined;
  createdAt: Date | undefined;
  updatedAt: Date | undefined;
  title: string;
  messageCount: number;
}

function querySessionRows(db: SqliteDatabase): DevinSessionQueryRow[] {
  let rawRows: unknown[] = [];
  try {
    rawRows = db
      .prepare(
        `SELECT s.id AS id,
                s.working_directory AS working_directory,
                s.model AS model,
                s.created_at AS created_at,
                s.last_activity_at AS last_activity_at,
                s.title AS title,
                COUNT(m.row_id) AS message_count
         FROM sessions s
         LEFT JOIN message_nodes m ON m.session_id = s.id
         WHERE COALESCE(s.hidden, 0) = 0
         GROUP BY s.id
         ORDER BY s.last_activity_at DESC`,
      )
      .all();
  } catch (err) {
    logger.debug('devin: sessions query failed', err);
    return [];
  }

  const rows: DevinSessionQueryRow[] = [];
  for (const raw of rawRows) {
    const result = DevinSessionRowSchema.safeParse(raw);
    if (!result.success) continue;
    const row = result.data;
    rows.push({
      id: row.id,
      working_directory: row.working_directory,
      model: row.model,
      createdAt: normalizeTimestamp(row.created_at),
      updatedAt: normalizeTimestamp(row.last_activity_at),
      title: row.title ?? '',
      messageCount:
        typeof (raw as Record<string, unknown>).message_count === 'number'
          ? ((raw as Record<string, unknown>).message_count as number)
          : 0,
    });
  }
  return rows;
}

/** First real user prompt, used when the session title is missing or generic. */
function getFirstUserMessage(db: SqliteDatabase, sessionId: string): string {
  let nodes: unknown[] = [];
  try {
    nodes = db
      .prepare(
        `SELECT chat_message FROM message_nodes
         WHERE session_id = ? ORDER BY node_id LIMIT 25`,
      )
      .all(sessionId);
  } catch (err) {
    logger.debug('devin: first-message lookup failed', sessionId, err);
    return '';
  }
  for (const node of nodes) {
    const chat = parseChatMessage((node as Record<string, unknown>).chat_message as string | undefined);
    if (!chat || chat.role !== 'user') continue;
    const text = (chat.content ?? '').trim();
    if (text && !isSystemContent(text) && isRealUserPrompt(text)) return text;
  }
  return '';
}

function isRealUserPrompt(text: string): boolean {
  return !text.startsWith('<') && !text.startsWith('/') && !text.includes('Session Handoff');
}

const GENERIC_TITLES = new Set(['', 'new session', 'untitled', 'untitled session']);

function listSessionsFromDb(db: SqliteDatabase, dbPath: string, options: SessionParseOptions): UnifiedSession[] {
  const rows = querySessionRows(db);
  const sessions: UnifiedSession[] = [];

  for (const row of rows) {
    if (row.messageCount <= 0) continue;

    const genericTitle = GENERIC_TITLES.has(row.title.trim().toLowerCase());
    const firstUserMessage = genericTitle ? getFirstUserMessage(db, row.id) : '';
    const summary = cleanSummary(genericTitle ? firstUserMessage : row.title || firstUserMessage);
    if (!summary) continue;

    const cwd = row.working_directory ?? '';
    if (options.cwd && cwd && path.resolve(cwd) !== path.resolve(options.cwd)) continue;

    const createdAt = row.createdAt ?? new Date(0);
    const updatedAt = row.updatedAt ?? createdAt;

    sessions.push({
      id: row.id,
      source: DEVIN_SOURCE,
      cwd,
      ...(cwd ? { repo: extractRepoFromCwd(cwd) } : {}),
      lines: row.messageCount,
      bytes: 0,
      createdAt,
      updatedAt,
      originalPath: dbPath,
      summary,
      ...(row.model ? { model: row.model } : {}),
    });
  }

  return sessions;
}

/**
 * Parse all Devin CLI sessions from every install channel's sessions.db.
 */
export async function parseDevinSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const sessions: UnifiedSession[] = [];

  for (const dbPath of getDevinDbPaths()) {
    const db = openReadOnlyDatabase(dbPath);
    if (!db) continue;
    try {
      sessions.push(...listSessionsFromDb(db, dbPath, options));
    } finally {
      closeDatabase(db, dbPath);
    }
  }

  sessions.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  return options.limit ? sessions.slice(0, options.limit) : sessions;
}

/**
 * Walk the conversation tree from the session's main chain tip up to the root.
 * Returns nodes in chronological (root → tip) order.
 */
function loadMainChain(db: SqliteDatabase, sessionId: string, mainChainId: number | undefined): DevinMessageNodeRow[] {
  let tip = mainChainId;
  if (tip === undefined) {
    try {
      const fallback = db
        .prepare('SELECT MAX(node_id) AS tip FROM message_nodes WHERE session_id = ?')
        .get(sessionId) as Record<string, unknown> | undefined;
      tip = typeof fallback?.tip === 'number' ? fallback.tip : undefined;
    } catch (err) {
      logger.debug('devin: chain tip lookup failed', sessionId, err);
      return [];
    }
  }
  if (tip === undefined) return [];

  const selectNode = db.prepare(
    `SELECT node_id, parent_node_id, chat_message, created_at
     FROM message_nodes WHERE session_id = ? AND node_id = ?`,
  );

  const chain: DevinMessageNodeRow[] = [];
  const visited = new Set<number>();
  let cursor: number | undefined = tip;

  while (cursor !== undefined && !visited.has(cursor) && chain.length < MAX_CHAIN_DEPTH) {
    visited.add(cursor);
    let raw: unknown;
    try {
      raw = selectNode.get(sessionId, cursor);
    } catch (err) {
      logger.debug('devin: chain node lookup failed', sessionId, cursor, err);
      break;
    }
    const result = DevinMessageNodeRowSchema.safeParse(raw);
    if (!result.success) break;
    const node = result.data;
    chain.push(node);
    cursor = node.parent_node_id ?? undefined;
  }

  return chain.reverse();
}

interface ExtractedDevinConversation {
  messages: ConversationMessage[];
  summaries: ReturnType<SummaryCollector['getSummaries']>;
  filesModified: string[];
  timeline: SessionEvent[];
}

function buildConversation(chain: DevinMessageNodeRow[], config: VerbosityConfig): ExtractedDevinConversation {
  const collector = new SummaryCollector(config);
  const messages: ConversationMessage[] = [];
  const timeline: SessionEvent[] = [];
  let sequence = 0;
  /** Unpaired tool calls from the most recent assistant message, in order. */
  let pendingCalls: { call: DevinToolCall; toolCall: ToolCall }[] = [];

  const attachResult = (resultText: string): void => {
    const pending = pendingCalls.shift();
    if (pending) pending.toolCall.result = truncate(resultText, 500);
  };

  for (const node of chain) {
    const chat = parseChatMessage(node.chat_message);
    if (!chat) continue;
    const timestamp = normalizeTimestamp(node.created_at);

    if (chat.role === 'system') continue;

    if (chat.role === 'user') {
      const text = (chat.content ?? '').trim();
      if (!text || isSystemContent(text)) continue;
      const message: ConversationMessage = { role: 'user', content: text, timestamp };
      messages.push(message);
      timeline.push({ kind: 'message', sequence: sequence++, ...message });
      pendingCalls = [];
      continue;
    }

    if (chat.role === 'tool') {
      const resultText = (chat.content ?? '').trim();
      if (resultText) attachResult(resultText);
      continue;
    }

    // assistant
    const text = (chat.content ?? '').trim();
    const toolCalls: ToolCall[] = (chat.tool_calls ?? []).map((call) => ({
      name: call.name,
      ...(call.id ? { id: call.id } : {}),
      ...(call.arguments ? { arguments: call.arguments } : {}),
    }));

    if (toolCalls.length > 0) {
      const assistantMessage: ConversationMessage = {
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        timestamp,
      };
      messages.push(assistantMessage);
      timeline.push({ kind: 'message', sequence: sequence++, ...assistantMessage });
      pendingCalls = toolCalls.map((toolCall, index) => ({ call: chat.tool_calls![index], toolCall }));
      recordToolSummaries(collector, chat.tool_calls ?? []);
      continue;
    }

    if (!text) continue;
    const assistantMessage: ConversationMessage = { role: 'assistant', content: text, timestamp };
    messages.push(assistantMessage);
    timeline.push({ kind: 'message', sequence: sequence++, ...assistantMessage });
  }

  return { messages, summaries: collector.getSummaries(), filesModified: collector.getFilesModified(), timeline };
}

function recordToolSummaries(collector: SummaryCollector, calls: DevinToolCall[]): void {
  for (const call of calls) {
    const category = classifyDevinToolName(call.name);
    if (!category) continue;
    const args = call.arguments ?? {};
    const firstString = (...keys: string[]): string => {
      for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value) return value;
      }
      return '';
    };

    switch (category) {
      case 'shell': {
        const command = firstString('command', 'cmd');
        collector.add(call.name, shellSummary(command), {
          data: { category: 'shell', command },
        });
        break;
      }
      case 'read':
        collector.add(call.name, fileSummary('read', firstString('file_path', 'path') || '(unknown file)'), {
          data: { category: 'read', filePath: firstString('file_path', 'path') || '(unknown file)' },
          filePath: firstString('file_path', 'path') || undefined,
        });
        break;
      case 'write': {
        const writePath = firstString('file_path', 'path') || '(unknown file)';
        collector.add(call.name, fileSummary('write', writePath, undefined, true), {
          data: { category: 'write', filePath: writePath, isNewFile: true },
          filePath: writePath,
          isWrite: true,
        });
        break;
      }
      case 'edit': {
        const editPath = firstString('file_path', 'path') || '(unknown file)';
        collector.add(call.name, fileSummary('edit', editPath), {
          data: { category: 'edit', filePath: editPath },
          filePath: editPath,
          isWrite: true,
        });
        break;
      }
      case 'grep':
        collector.add(call.name, grepSummary(firstString('pattern', 'query')), {
          data: { category: 'grep', pattern: firstString('pattern', 'query') },
        });
        break;
      case 'glob':
        collector.add(call.name, globSummary(firstString('pattern', 'glob')), {
          data: { category: 'glob', pattern: firstString('pattern', 'glob') },
        });
        break;
      case 'search':
        collector.add(call.name, searchSummary(firstString('query', 'search')), {
          data: { category: 'search', query: firstString('query', 'search') },
        });
        break;
      case 'fetch':
        collector.add(call.name, fetchSummary(firstString('url')), {
          data: { category: 'fetch', url: firstString('url') },
        });
        break;
      case 'task':
        collector.add(call.name, subagentSummary(firstString('task', 'description', 'prompt')), {
          data: { category: 'task', description: firstString('task', 'description', 'prompt') },
        });
        break;
      default:
        collector.add(call.name, mcpSummary(call.name, truncate(JSON.stringify(args), 80)));
        break;
    }
  }
}

function emptyContext(
  session: UnifiedSession,
  config: VerbosityConfig,
  warning: string,
  dbPath: string | undefined,
): SessionContext {
  const sessionNotes: SessionNotes = {
    ...(warning ? { fidelityWarnings: [warning] } : {}),
    ...(dbPath ? { rawAccess: { kind: 'sqlite', path: dbPath } } : {}),
  };
  return {
    session,
    recentMessages: [],
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    sessionNotes,
    markdown: generateHandoffMarkdown(session, [], [], [], [], sessionNotes, config),
  };
}

/**
 * Extract context from a Devin CLI session for cross-tool continuation.
 */
export async function extractDevinContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const dbPath = session.originalPath;
  if (!dbPath || !fs.existsSync(dbPath)) {
    return emptyContext(session, resolvedConfig, 'Devin sessions.db was not found or was unreadable.', dbPath);
  }

  const db = openReadOnlyDatabase(dbPath);
  if (!db) {
    return emptyContext(session, resolvedConfig, 'Devin sessions.db could not be opened.', dbPath);
  }

  try {
    let mainChainId: number | undefined;
    try {
      const row = db.prepare('SELECT main_chain_id FROM sessions WHERE id = ?').get(session.id) as
        | Record<string, unknown>
        | undefined;
      mainChainId = typeof row?.main_chain_id === 'number' ? row.main_chain_id : undefined;
    } catch (err) {
      logger.debug('devin: session lookup failed', session.id, err);
    }

    const chain = loadMainChain(db, session.id, mainChainId);
    if (chain.length === 0) {
      return emptyContext(session, resolvedConfig, 'Devin conversation chain was empty or unreadable.', dbPath);
    }

    const extracted = buildConversation(chain, resolvedConfig);

    // Balanced tail: keep the last N messages but ensure a user message survives.
    const tail = extracted.messages.slice(-resolvedConfig.recentMessages);
    const recentMessages =
      tail.some((m) => m.role === 'user') || extracted.messages.length <= resolvedConfig.recentMessages
        ? tail
        : [...extracted.messages.filter((m) => m.role === 'user').slice(-1), ...tail];

    const sessionNotes: SessionNotes = {
      ...(session.model ? { model: session.model } : {}),
      rawAccess: { kind: 'sqlite', path: dbPath },
    };

    const markdown = generateHandoffMarkdown(
      session,
      recentMessages,
      extracted.filesModified,
      [],
      extracted.summaries,
      sessionNotes,
      resolvedConfig,
      'inline',
      extracted.timeline,
    );

    return {
      session,
      recentMessages,
      filesModified: extracted.filesModified,
      pendingTasks: [],
      toolSummaries: extracted.summaries,
      sessionNotes,
      timeline: extracted.timeline,
      markdown,
    };
  } finally {
    closeDatabase(db, dbPath);
  }
}

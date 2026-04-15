import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { z } from 'zod';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  ToolCall,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import type {
  OpenCodeProject,
  OpenCodeSession,
  SqliteMessageRow,
  SqlitePartRow,
  SqliteProjectRow,
  SqliteSessionRow,
} from '../types/schemas.js';
import {
  OpenCodeMessageSchema,
  OpenCodePartSchema,
  OpenCodeProjectSchema,
  OpenCodeSessionSchema,
} from '../types/schemas.js';
import { findFiles, listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { SummaryCollector, truncate } from '../utils/tool-summarizer.js';

/** Minimal typed interface for node:sqlite DatabaseSync */
interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

/** Zod schema for message data blob stored in SQLite data column */
const SqliteMsgDataSchema = z.object({ role: z.string() }).passthrough();

/** Zod schema for part data blob stored in SQLite data column */
const SqlitePartDataSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

function getOpenCodeBaseDir(): string {
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'opencode')
    : path.join(homeDir(), '.local', 'share', 'opencode');
}

function getOpenCodeStorageDir(): string {
  return path.join(getOpenCodeBaseDir(), 'storage');
}

function getOpenCodeDbPath(): string {
  if (process.env.OPENCODE_DB) {
    return process.env.OPENCODE_DB;
  }

  const baseDir = getOpenCodeBaseDir();
  const defaultDbPath = path.join(baseDir, 'opencode.db');
  if (fs.existsSync(defaultDbPath)) {
    return defaultDbPath;
  }

  try {
    const channelDbPaths = fs
      .readdirSync(baseDir)
      .filter((entry) => /^opencode-[^.]+\.db$/u.test(entry))
      .map((entry) => path.join(baseDir, entry))
      .sort((left, right) => {
        const rightStat = fs.statSync(right);
        const leftStat = fs.statSync(left);
        return rightStat.mtimeMs - leftStat.mtimeMs || left.localeCompare(right);
      });
    if (channelDbPaths.length > 0) {
      return channelDbPaths[0];
    }
  } catch (err) {
    logger.debug('opencode: failed to inspect channel SQLite DB variants', baseDir, err);
  }

  return defaultDbPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function previewUnknown(value: unknown, maxLength = 160): string {
  if (typeof value === 'string') {
    return truncate(normalizeWhitespace(value), maxLength);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value === null || value === undefined) {
    return '';
  }

  try {
    return truncate(normalizeWhitespace(JSON.stringify(value)), maxLength);
  } catch (err) {
    logger.debug('opencode: failed to stringify preview value', err);
    return '';
  }
}

function extractGenericPartPreview(
  partData: Record<string, unknown>,
  preferredKeys: string[] = ['text', 'title', 'summary', 'message', 'content', 'patch', 'diff'],
): string {
  for (const key of preferredKeys) {
    const preview = previewUnknown(partData[key]);
    if (preview) return preview;
  }

  const state = isRecord(partData.state) ? partData.state : undefined;
  if (state) {
    for (const key of ['output', 'error', 'title', 'input']) {
      const preview = previewUnknown(state[key]);
      if (preview) return preview;
    }
  }

  return '';
}

function normalizeToolArguments(input: unknown): Record<string, unknown> | undefined {
  if (isRecord(input)) return input;
  if (input === undefined) return undefined;
  return { value: input };
}

function renderToolPart(partData: Record<string, unknown>): {
  content: string;
  toolCall: ToolCall;
  summary: string;
  toolName: string;
  isError: boolean;
} | null {
  const toolName = typeof partData.tool === 'string' ? partData.tool : 'tool';
  const state = isRecord(partData.state) ? partData.state : {};
  const status = typeof state.status === 'string' ? state.status : undefined;
  const resultPreview = previewUnknown(state.output) || previewUnknown(state.error);
  const argPreview = previewUnknown(state.input, 120);

  const detailBits = [argPreview, resultPreview].filter(Boolean);
  const statusLabel = status ? ` ${status}` : '';
  const content = [`[tool:${toolName}${statusLabel}]`, ...detailBits].join(' ').trim();

  const summaryBits = [status, argPreview && `input=${argPreview}`, resultPreview && `result=${resultPreview}`].filter(
    Boolean,
  );
  const summary = summaryBits.length > 0 ? summaryBits.join(' | ') : 'invoked';
  const success = status === 'completed' ? true : status === 'error' ? false : undefined;

  return {
    content,
    toolName,
    summary,
    isError: success === false,
    toolCall: {
      name: toolName,
      ...(typeof partData.callID === 'string' ? { id: partData.callID } : {}),
      ...(normalizeToolArguments(state.input) ? { arguments: normalizeToolArguments(state.input) } : {}),
      ...(resultPreview ? { result: resultPreview } : {}),
      ...(success !== undefined ? { success } : {}),
    },
  };
}

function renderHighValuePart(partData: Record<string, unknown>): {
  content?: string;
  toolCall?: ToolCall;
} {
  switch (partData.type) {
    case 'text':
      return { content: typeof partData.text === 'string' ? partData.text : undefined };
    case 'reasoning': {
      const preview = extractGenericPartPreview(partData, ['text', 'summary', 'content']);
      return preview ? { content: `[reasoning] ${preview}` } : {};
    }
    case 'tool': {
      const rendered = renderToolPart(partData);
      return rendered ? { content: rendered.content, toolCall: rendered.toolCall } : {};
    }
    case 'patch':
    case 'compaction':
    case 'snapshot':
    case 'agent':
    case 'retry':
    case 'subtask': {
      const preview = extractGenericPartPreview(partData);
      return preview ? { content: `[${partData.type}] ${preview}` } : {};
    }
    default:
      return {};
  }
}

/**
 * Check if SQLite DB exists and is usable
 */
function hasSqliteDb(): boolean {
  return fs.existsSync(getOpenCodeDbPath());
}

/**
 * Open SQLite database using node:sqlite (built-in)
 */
function openDb(): { db: SqliteDatabase; close: () => void } | null {
  const dbPath = getOpenCodeDbPath();
  try {
    // Dynamic import of node:sqlite to avoid issues on older Node versions
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true }) as SqliteDatabase;
    return { db, close: () => db.close() };
  } catch (err) {
    logger.debug('opencode: failed to open SQLite database', dbPath, err);
    return null;
  }
}

/**
 * Find all OpenCode session files
 */
async function findSessionFiles(): Promise<string[]> {
  const sessionDir = path.join(getOpenCodeStorageDir(), 'session');
  const results: string[] = [];
  for (const projectDir of listSubdirectories(sessionDir)) {
    results.push(
      ...findFiles(projectDir, {
        match: (entry) => entry.name.startsWith('ses_') && entry.name.endsWith('.json'),
        recursive: false,
      }),
    );
  }
  return results;
}

/**
 * Parse a single OpenCode session file
 */
function parseSessionFile(filePath: string): OpenCodeSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const result = OpenCodeSessionSchema.safeParse(JSON.parse(content));
    if (result.success) return result.data;
    logger.debug('opencode: session validation failed', filePath, result.error.message);
    return null;
  } catch (err) {
    logger.debug('opencode: failed to parse session file', filePath, err);
    return null;
  }
}

/**
 * Load project info to get worktree/cwd
 */
function loadProjectInfo(projectId: string): OpenCodeProject | null {
  const projectFile = path.join(getOpenCodeStorageDir(), 'project', `${projectId}.json`);
  try {
    if (fs.existsSync(projectFile)) {
      const content = fs.readFileSync(projectFile, 'utf8');
      const result = OpenCodeProjectSchema.safeParse(JSON.parse(content));
      if (result.success) return result.data;
      logger.debug('opencode: project validation failed', projectFile, result.error.message);
    }
  } catch (err) {
    logger.debug('opencode: failed to parse project file', projectFile, err);
  }
  return null;
}

/**
 * Get first user message from session messages
 */
function getFirstUserMessage(sessionId: string): string {
  const messageDir = path.join(getOpenCodeStorageDir(), 'message', sessionId);
  if (!fs.existsSync(messageDir)) return '';

  try {
    const messageFiles = fs
      .readdirSync(messageDir)
      .filter((f) => f.startsWith('msg_') && f.endsWith('.json'))
      .sort(); // Sort to get chronological order

    for (const msgFile of messageFiles) {
      const msgPath = path.join(messageDir, msgFile);
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msgResult = OpenCodeMessageSchema.safeParse(JSON.parse(msgContent));
      if (!msgResult.success) continue;
      const msg = msgResult.data;

      if (msg.role === 'user') {
        // Get the message text from parts
        const messageId = msg.id;
        const partDir = path.join(getOpenCodeStorageDir(), 'part', messageId);

        if (fs.existsSync(partDir)) {
          const partFiles = fs
            .readdirSync(partDir)
            .filter((f) => f.startsWith('prt_') && f.endsWith('.json'))
            .sort();

          for (const partFile of partFiles) {
            const partPath = path.join(partDir, partFile);
            const partContent = fs.readFileSync(partPath, 'utf8');
            const partResult = OpenCodePartSchema.safeParse(JSON.parse(partContent));
            if (!partResult.success) continue;
            const part = partResult.data;

            if (part.type === 'text' && part.text) {
              return part.text;
            }
          }
        }
      }
    }
  } catch (err) {
    logger.debug('opencode: failed to read messages for session', sessionId, err);
  }

  return '';
}

/**
 * Count message lines for a session
 */
function countSessionLines(sessionId: string): number {
  const messageDir = path.join(getOpenCodeStorageDir(), 'message', sessionId);
  if (!fs.existsSync(messageDir)) return 0;

  try {
    const messageFiles = fs.readdirSync(messageDir).filter((f) => f.startsWith('msg_') && f.endsWith('.json'));
    return messageFiles.length;
  } catch (err) {
    logger.debug('opencode: failed to count messages for session', sessionId, err);
    return 0;
  }
}

/**
 * Parse all OpenCode sessions - SQLite first, then JSON fallback
 */
export async function parseOpenCodeSessions(): Promise<UnifiedSession[]> {
  // Try SQLite database first (newer OpenCode versions)
  if (hasSqliteDb()) {
    const sessions = parseSessionsFromSqlite();
    if (sessions.length > 0) return sessions;
  }

  // Fallback to JSON files (older OpenCode versions)
  return parseSessionsFromJson();
}

/**
 * Parse sessions from SQLite database
 */
function parseSessionsFromSqlite(): UnifiedSession[] {
  const handle = openDb();
  if (!handle) return [];

  const { db, close } = handle;
  try {
    const rows = db
      .prepare(
        'SELECT id, project_id, slug, directory, title, version, summary_additions, summary_deletions, summary_files, time_created, time_updated FROM session ORDER BY time_updated DESC',
      )
      .all() as SqliteSessionRow[];

    // Build project lookup
    const projectRows = db.prepare('SELECT id, worktree FROM project').all() as SqliteProjectRow[];
    const projectMap = new Map(projectRows.map((p: SqliteProjectRow) => [p.id, p.worktree]));

    const sessions: UnifiedSession[] = [];

    for (const row of rows) {
      const cwd = row.directory || projectMap.get(row.project_id) || '';

      // Count messages for this session
      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM message WHERE session_id = ?').get(row.id) as
        | { cnt: number }
        | undefined;

      // Get first user message for summary if no title
      let summary = row.title || '';
      if (!summary || summary.startsWith('New session')) {
        const firstMsg = db
          .prepare(
            'SELECT m.id, p.data FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND m.data LIKE \'%"role":"user"%\' AND p.data LIKE \'%"type":"text"%\' ORDER BY m.time_created ASC LIMIT 1',
          )
          .get(row.id) as { id: string; data: string } | undefined;

        if (firstMsg) {
          try {
            const partData = JSON.parse(firstMsg.data);
            if (partData.text) {
              summary = partData.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
            }
          } catch (err) {
            logger.debug('opencode: failed to parse SQLite first-message part', row.id, err);
          }
        }
      }

      sessions.push({
        id: row.id,
        source: 'opencode',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines: msgCount?.cnt ?? 0,
        bytes: 0, // SQLite doesn't have per-session file size
        createdAt: new Date(row.time_created),
        updatedAt: new Date(row.time_updated),
        originalPath: getOpenCodeDbPath(),
        summary: summary?.slice(0, 60) || row.slug || undefined,
        model: undefined,
      });
    }

    return sessions;
  } catch (err) {
    logger.debug('opencode: SQLite session query failed', err);
    return [];
  } finally {
    close();
  }
}

/**
 * Parse sessions from JSON files (legacy)
 */
async function parseSessionsFromJson(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const session = parseSessionFile(filePath);
      if (!session || !session.id) continue;

      // Get project info for worktree
      const project = loadProjectInfo(session.projectID);
      const cwd = session.directory || project?.worktree || '';

      // Get first user message for summary
      const firstUserMessage = getFirstUserMessage(session.id);
      const summary = session.title || firstUserMessage.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);

      const fileStats = fs.statSync(filePath);
      const lines = countSessionLines(session.id);

      sessions.push({
        id: session.id,
        source: 'opencode',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines,
        bytes: fileStats.size,
        createdAt: new Date(session.time.created),
        updatedAt: new Date(session.time.updated),
        originalPath: filePath,
        summary: summary || session.slug || undefined,
      });
    } catch (err) {
      logger.debug('opencode: skipping unparseable JSON session', filePath, err);
      // Skip files we can't parse
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Read all messages from an OpenCode session - SQLite first, then JSON fallback
 */
function readAllMessages(sessionId: string): ConversationMessage[] {
  // Try SQLite first
  if (hasSqliteDb()) {
    const msgs = readMessagesFromSqlite(sessionId);
    if (msgs.length > 0) return msgs;
  }

  // Fallback to JSON files
  return readMessagesFromJson(sessionId);
}

/**
 * Read messages from SQLite database
 */
function readMessagesFromSqlite(sessionId: string): ConversationMessage[] {
  const handle = openDb();
  if (!handle) return [];

  const { db, close } = handle;
  try {
    // Get messages with their data
    const msgRows = db
      .prepare('SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
      .all(sessionId) as SqliteMessageRow[];

    const messages: ConversationMessage[] = [];

    for (const msgRow of msgRows) {
      const msgDataResult = SqliteMsgDataSchema.safeParse(JSON.parse(msgRow.data));
      if (!msgDataResult.success) continue;
      const role: 'user' | 'assistant' = msgDataResult.data.role === 'user' ? 'user' : 'assistant';

      // Get text parts for this message
      const partRows = db
        .prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC')
        .all(msgRow.id) as SqlitePartRow[];

      const contentParts: string[] = [];
      const toolCalls: NonNullable<ConversationMessage['toolCalls']> = [];
      for (const partRow of partRows) {
        let rawPartData: unknown;
        try {
          rawPartData = JSON.parse(partRow.data);
        } catch (err) {
          logger.debug('opencode: failed to parse SQLite part JSON', msgRow.id, err);
          continue;
        }

        const partDataResult = SqlitePartDataSchema.safeParse(rawPartData);
        if (!partDataResult.success) continue;
        const rendered = renderHighValuePart(partDataResult.data);
        if (rendered.content) contentParts.push(rendered.content);
        if (rendered.toolCall) toolCalls.push(rendered.toolCall);
      }

      const content = contentParts.join('\n').trim();
      if (content) {
        messages.push({
          role,
          content,
          timestamp: new Date(msgRow.time_created),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      }
    }

    return messages;
  } catch (err) {
    logger.debug('opencode: SQLite message query failed for session', sessionId, err);
    return [];
  } finally {
    close();
  }
}

/**
 * Read messages from JSON files (legacy)
 */
function readMessagesFromJson(sessionId: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const messageDir = path.join(getOpenCodeStorageDir(), 'message', sessionId);

  if (!fs.existsSync(messageDir)) return messages;

  try {
    const messageFiles = fs
      .readdirSync(messageDir)
      .filter((f) => f.startsWith('msg_') && f.endsWith('.json'))
      .sort();

    for (const msgFile of messageFiles) {
      const msgPath = path.join(messageDir, msgFile);
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msgResult = OpenCodeMessageSchema.safeParse(JSON.parse(msgContent));
      if (!msgResult.success) continue;
      const msg = msgResult.data;

      // Get message text from parts
      const partDir = path.join(getOpenCodeStorageDir(), 'part', msg.id);
      const contentParts: string[] = [];
      const toolCalls: NonNullable<ConversationMessage['toolCalls']> = [];

      if (fs.existsSync(partDir)) {
        const partFiles = fs
          .readdirSync(partDir)
          .filter((f) => f.startsWith('prt_') && f.endsWith('.json'))
          .sort();

        for (const partFile of partFiles) {
          const partPath = path.join(partDir, partFile);
          const partContent = fs.readFileSync(partPath, 'utf8');
          const partResult = OpenCodePartSchema.safeParse(JSON.parse(partContent));
          if (!partResult.success) continue;
          const rendered = renderHighValuePart(partResult.data);
          if (rendered.content) contentParts.push(rendered.content);
          if (rendered.toolCall) toolCalls.push(rendered.toolCall);
        }
      }

      const content = contentParts.join('\n').trim();
      if (content) {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content,
          timestamp: new Date(msg.time.created),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      }
    }
  } catch (err) {
    logger.debug('opencode: failed to read JSON messages for session', sessionId, err);
    // Ignore errors
  }

  return messages;
}

/**
 * Extract tool-level summary from OpenCode session metadata.
 * OpenCode stores additions/deletions/files at the session level (not per-tool),
 * so we produce a single high-level "Edit" summary when data is available.
 */
function extractOpenCodeToolSummaries(sessionId: string): ToolUsageSummary[] {
  const collector = new SummaryCollector();

  if (hasSqliteDb()) {
    const sqliteSummaries = extractOpenCodeToolSummariesFromSqlite(sessionId, collector);
    if (sqliteSummaries.length > 0) {
      return sqliteSummaries;
    }
  }

  return extractOpenCodeToolSummariesFromJson(sessionId, collector);
}

function extractOpenCodeToolSummariesFromSqlite(sessionId: string, collector: SummaryCollector): ToolUsageSummary[] {
  const handle = openDb();
  if (!handle) return [];

  const { db, close } = handle;
  try {
    const sessionRow = db
      .prepare('SELECT summary_additions, summary_deletions, summary_files FROM session WHERE id = ?')
      .get(sessionId) as
      | {
          summary_additions: number | null;
          summary_deletions: number | null;
          summary_files: number | null;
        }
      | undefined;

    const added = sessionRow?.summary_additions ?? 0;
    const removed = sessionRow?.summary_deletions ?? 0;
    const files = sessionRow?.summary_files ?? 0;
    if (files > 0 || added > 0 || removed > 0) {
      collector.add('Edit', `${files} file(s) changed (+${added} -${removed})`, {
        data: {
          category: 'edit',
          filePath: `(${files} files)`,
          diffStats: { added, removed },
        },
      });
    }

    const partRows = db
      .prepare('SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC')
      .all(sessionId) as SqlitePartRow[];

    for (const partRow of partRows) {
      let rawPartData: unknown;
      try {
        rawPartData = JSON.parse(partRow.data);
      } catch (err) {
        logger.debug('opencode: failed to parse SQLite tool-summary part JSON', sessionId, err);
        continue;
      }

      const partDataResult = SqlitePartDataSchema.safeParse(rawPartData);
      if (!partDataResult.success || partDataResult.data.type !== 'tool') continue;

      const rendered = renderToolPart(partDataResult.data);
      if (!rendered) continue;
      collector.add(rendered.toolName, rendered.summary, { isError: rendered.isError });
    }

    return collector.getSummaries();
  } catch (err) {
    logger.debug('opencode: SQLite tool summary query failed', sessionId, err);
    return [];
  } finally {
    close();
  }
}

function extractOpenCodeToolSummariesFromJson(sessionId: string, collector: SummaryCollector): ToolUsageSummary[] {
  const sessionDir = path.join(getOpenCodeStorageDir(), 'session');
  try {
    for (const projectDir of listSubdirectories(sessionDir)) {
      const sessionFile = path.join(projectDir, `${sessionId}.json`);
      if (!fs.existsSync(sessionFile)) continue;
      const content = fs.readFileSync(sessionFile, 'utf8');
      const result = OpenCodeSessionSchema.safeParse(JSON.parse(content));
      if (!result.success) break;
      const raw = result.data;
      if (raw.summary && (raw.summary.additions || raw.summary.deletions || raw.summary.files)) {
        const added = raw.summary.additions || 0;
        const removed = raw.summary.deletions || 0;
        const files = raw.summary.files || 0;
        collector.add('Edit', `${files} file(s) changed (+${added} -${removed})`, {
          data: {
            category: 'edit',
            filePath: `(${files} files)`,
            diffStats: { added, removed },
          },
        });
      }
      break;
    }
  } catch (err) {
    logger.debug('opencode: failed to read JSON tool summaries', sessionId, err);
  }

  const messageDir = path.join(getOpenCodeStorageDir(), 'message', sessionId);
  if (!fs.existsSync(messageDir)) {
    return collector.getSummaries();
  }

  try {
    const messageFiles = fs
      .readdirSync(messageDir)
      .filter((fileName) => fileName.startsWith('msg_') && fileName.endsWith('.json'))
      .sort();

    for (const messageFile of messageFiles) {
      const messagePath = path.join(messageDir, messageFile);
      const messageContent = fs.readFileSync(messagePath, 'utf8');
      const messageResult = OpenCodeMessageSchema.safeParse(JSON.parse(messageContent));
      if (!messageResult.success) continue;

      const partDir = path.join(getOpenCodeStorageDir(), 'part', messageResult.data.id);
      if (!fs.existsSync(partDir)) continue;

      const partFiles = fs
        .readdirSync(partDir)
        .filter((fileName) => fileName.startsWith('prt_') && fileName.endsWith('.json'))
        .sort();

      for (const partFile of partFiles) {
        const partPath = path.join(partDir, partFile);
        const partContent = fs.readFileSync(partPath, 'utf8');
        const partResult = OpenCodePartSchema.safeParse(JSON.parse(partContent));
        if (!partResult.success || partResult.data.type !== 'tool') continue;

        const rendered = renderToolPart(partResult.data);
        if (!rendered) continue;
        collector.add(rendered.toolName, rendered.summary, { isError: rendered.isError });
      }
    }
  } catch (err) {
    logger.debug('opencode: failed to read JSON tool-part summaries', sessionId, err);
  }

  return collector.getSummaries();
}

/**
 * Extract context from an OpenCode session for cross-tool continuation
 */
export async function extractOpenCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const recentMessages = readAllMessages(session.id);
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];
  const toolSummaries = extractOpenCodeToolSummaries(session.id);

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    undefined,
    resolvedConfig,
  );

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    markdown,
  };
}

import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, UnifiedSession } from '../types/index.js';
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

const OPENCODE_BASE_DIR = path.join(homeDir(), '.local', 'share', 'opencode');
const OPENCODE_STORAGE_DIR = path.join(OPENCODE_BASE_DIR, 'storage');
const OPENCODE_DB_PATH = path.join(OPENCODE_BASE_DIR, 'opencode.db');

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

/**
 * Check if SQLite DB exists and is usable
 */
function hasSqliteDb(): boolean {
  return fs.existsSync(OPENCODE_DB_PATH);
}

/**
 * Open SQLite database using node:sqlite (built-in)
 */
function openDb(): { db: SqliteDatabase; close: () => void } | null {
  try {
    // Dynamic import of node:sqlite to avoid issues on older Node versions
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(OPENCODE_DB_PATH, { open: true, readOnly: true }) as SqliteDatabase;
    return { db, close: () => db.close() };
  } catch (err) {
    logger.debug('opencode: failed to open SQLite database', OPENCODE_DB_PATH, err);
    return null;
  }
}

/**
 * Find all OpenCode session files
 */
async function findSessionFiles(): Promise<string[]> {
  const sessionDir = path.join(OPENCODE_STORAGE_DIR, 'session');
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
  const projectFile = path.join(OPENCODE_STORAGE_DIR, 'project', `${projectId}.json`);
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
  const messageDir = path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
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
        const partDir = path.join(OPENCODE_STORAGE_DIR, 'part', messageId);

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
  const messageDir = path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
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
          } catch (_err) {
            /* ignore malformed part data */
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
        originalPath: OPENCODE_DB_PATH,
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
        .prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC')
        .all(msgRow.id) as SqlitePartRow[];

      let text = '';
      for (const partRow of partRows) {
        const partDataResult = SqlitePartDataSchema.safeParse(JSON.parse(partRow.data));
        if (!partDataResult.success) continue;
        if (partDataResult.data.type === 'text' && partDataResult.data.text) {
          text += partDataResult.data.text + '\n';
        }
      }

      if (text.trim()) {
        messages.push({
          role,
          content: text.trim(),
          timestamp: new Date(msgRow.time_created),
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
  const messageDir = path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);

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
      const partDir = path.join(OPENCODE_STORAGE_DIR, 'part', msg.id);
      let text = '';

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
            text += part.text + '\n';
          }
        }
      }

      if (text.trim()) {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: text.trim(),
          timestamp: new Date(msg.time.created),
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
 * Extract context from an OpenCode session for cross-tool continuation
 */
export async function extractOpenCodeContext(session: UnifiedSession): Promise<SessionContext> {
  const recentMessages = readAllMessages(session.id);
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];

  const markdown = generateHandoffMarkdown(session, recentMessages.slice(-10), filesModified, pendingTasks, []);

  return {
    session,
    recentMessages: recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    toolSummaries: [],
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

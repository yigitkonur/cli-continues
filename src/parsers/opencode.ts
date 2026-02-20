import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import type { UnifiedSession, SessionContext, ConversationMessage } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';

const OPENCODE_BASE_DIR = path.join(homeDir(), '.local', 'share', 'opencode');
const OPENCODE_STORAGE_DIR = path.join(OPENCODE_BASE_DIR, 'storage');
const OPENCODE_DB_PATH = path.join(OPENCODE_BASE_DIR, 'opencode.db');

interface OpenCodeSession {
  id: string;
  slug?: string;
  version?: string;
  projectID: string;
  directory: string;
  title?: string;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

interface OpenCodeProject {
  id: string;
  worktree: string;
  vcs?: string;
  time?: {
    created: number;
    updated: number;
  };
}

interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
    completed?: number;
  };
  summary?: {
    title?: string;
  };
  path?: {
    cwd?: string;
    root?: string;
  };
}

interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
}

// SQLite row types
interface SqliteSessionRow {
  id: string;
  project_id: string;
  slug: string;
  directory: string;
  title: string;
  version: string;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  time_created: number;
  time_updated: number;
}

interface SqliteMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface SqlitePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface SqliteProjectRow {
  id: string;
  worktree: string;
}

/**
 * Check if SQLite DB exists and is usable
 */
function hasSqliteDb(): boolean {
  return fs.existsSync(OPENCODE_DB_PATH);
}

/**
 * Open SQLite database using node:sqlite (built-in)
 */
function openDb(): { db: any; close: () => void } | null {
  try {
    // Dynamic import of node:sqlite to avoid issues on older Node versions
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(OPENCODE_DB_PATH, { open: true, readOnly: true });
    return { db, close: () => db.close() };
  } catch {
    return null;
  }
}

/**
 * Find all OpenCode session files
 */
async function findSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  const sessionDir = path.join(OPENCODE_STORAGE_DIR, 'session');
  
  if (!fs.existsSync(sessionDir)) {
    return files;
  }

  try {
    // Iterate through project hash directories
    const projectDirs = fs.readdirSync(sessionDir, { withFileTypes: true });
    
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      
      const projectPath = path.join(sessionDir, projectDir.name);
      const sessionFiles = fs.readdirSync(projectPath, { withFileTypes: true });
      
      for (const sessionFile of sessionFiles) {
        if (sessionFile.isFile() && sessionFile.name.startsWith('ses_') && sessionFile.name.endsWith('.json')) {
          files.push(path.join(projectPath, sessionFile.name));
        }
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return files;
}

/**
 * Parse a single OpenCode session file
 */
function parseSessionFile(filePath: string): OpenCodeSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as OpenCodeSession;
  } catch {
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
      return JSON.parse(content) as OpenCodeProject;
    }
  } catch {
    // Ignore parse errors
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
    const messageFiles = fs.readdirSync(messageDir)
      .filter(f => f.startsWith('msg_') && f.endsWith('.json'))
      .sort(); // Sort to get chronological order

    for (const msgFile of messageFiles) {
      const msgPath = path.join(messageDir, msgFile);
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msg = JSON.parse(msgContent) as OpenCodeMessage;
      
      if (msg.role === 'user') {
        // Get the message text from parts
        const messageId = msg.id;
        const partDir = path.join(OPENCODE_STORAGE_DIR, 'part', messageId);
        
        if (fs.existsSync(partDir)) {
          const partFiles = fs.readdirSync(partDir)
            .filter(f => f.startsWith('prt_') && f.endsWith('.json'))
            .sort();
          
          for (const partFile of partFiles) {
            const partPath = path.join(partDir, partFile);
            const partContent = fs.readFileSync(partPath, 'utf8');
            const part = JSON.parse(partContent) as OpenCodePart;
            
            if (part.type === 'text' && part.text) {
              return part.text;
            }
          }
        }
      }
    }
  } catch {
    // Ignore errors
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
    const messageFiles = fs.readdirSync(messageDir)
      .filter(f => f.startsWith('msg_') && f.endsWith('.json'));
    return messageFiles.length;
  } catch {
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
    const rows = db.prepare(
      'SELECT id, project_id, slug, directory, title, version, summary_additions, summary_deletions, summary_files, time_created, time_updated FROM session ORDER BY time_updated DESC'
    ).all() as SqliteSessionRow[];

    // Build project lookup
    const projectRows = db.prepare('SELECT id, worktree FROM project').all() as SqliteProjectRow[];
    const projectMap = new Map(projectRows.map((p: SqliteProjectRow) => [p.id, p.worktree]));

    const sessions: UnifiedSession[] = [];

    for (const row of rows) {
      const cwd = row.directory || projectMap.get(row.project_id) || '';
      
      // Count messages for this session
      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM message WHERE session_id = ?').get(row.id) as { cnt: number };

      // Get first user message for summary if no title
      let summary = row.title || '';
      if (!summary || summary.startsWith('New session')) {
        const firstMsg = db.prepare(
          "SELECT m.id, p.data FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND m.data LIKE '%\"role\":\"user\"%' AND p.data LIKE '%\"type\":\"text\"%' ORDER BY m.time_created ASC LIMIT 1"
        ).get(row.id) as { id: string; data: string } | undefined;
        
        if (firstMsg) {
          try {
            const partData = JSON.parse(firstMsg.data);
            if (partData.text) {
              summary = partData.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
            }
          } catch { /* ignore */ }
        }
      }

      sessions.push({
        id: row.id,
        source: 'opencode',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines: (msgCount?.cnt ?? 0),
        bytes: 0, // SQLite doesn't have per-session file size
        createdAt: new Date(row.time_created),
        updatedAt: new Date(row.time_updated),
        originalPath: OPENCODE_DB_PATH,
        summary: summary?.slice(0, 60) || row.slug || undefined,
        model: undefined,
      });
    }

    return sessions;
  } catch {
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
      const summary = session.title || firstUserMessage
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50);

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
    } catch {
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
    const msgRows = db.prepare(
      'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC'
    ).all(sessionId) as SqliteMessageRow[];

    const messages: ConversationMessage[] = [];

    for (const msgRow of msgRows) {
      const msgData = JSON.parse(msgRow.data) as { role: string; [key: string]: unknown };
      const role = msgData.role === 'user' ? 'user' : 'assistant';
      
      // Get text parts for this message
      const partRows = db.prepare(
        "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC"
      ).all(msgRow.id) as SqlitePartRow[];

      let text = '';
      for (const partRow of partRows) {
        const partData = JSON.parse(partRow.data) as { type: string; text?: string };
        if (partData.type === 'text' && partData.text) {
          text += partData.text + '\n';
        }
      }

      if (text.trim()) {
        messages.push({
          role: role as 'user' | 'assistant',
          content: text.trim(),
          timestamp: new Date(msgRow.time_created),
        });
      }
    }

    return messages;
  } catch {
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
    const messageFiles = fs.readdirSync(messageDir)
      .filter(f => f.startsWith('msg_') && f.endsWith('.json'))
      .sort();

    for (const msgFile of messageFiles) {
      const msgPath = path.join(messageDir, msgFile);
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msg = JSON.parse(msgContent) as OpenCodeMessage;
      
      // Get message text from parts
      const partDir = path.join(OPENCODE_STORAGE_DIR, 'part', msg.id);
      let text = '';
      
      if (fs.existsSync(partDir)) {
        const partFiles = fs.readdirSync(partDir)
          .filter(f => f.startsWith('prt_') && f.endsWith('.json'))
          .sort();
        
        for (const partFile of partFiles) {
          const partPath = path.join(partDir, partFile);
          const partContent = fs.readFileSync(partPath, 'utf8');
          const part = JSON.parse(partContent) as OpenCodePart;
          
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
  } catch {
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

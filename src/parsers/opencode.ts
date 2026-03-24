import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { z } from 'zod';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  ReasoningStep,
  SessionContext,
  SessionNotes,
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
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { countDiffStats, extractStdoutTail } from '../utils/diff.js';
import {
  extractExitCode,
  mcpSummary,
  searchSummary,
  shellSummary,
  SummaryCollector,
  truncate,
  withResult,
  globSummary,
  fileSummary,
} from '../utils/tool-summarizer.js';

const OPENCODE_BASE_DIR = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'opencode')
  : path.join(homeDir(), '.local', 'share', 'opencode');
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
const SqliteMsgDataSchema = z
  .object({
    role: z.string(),
    modelID: z.string().optional(),
    providerID: z.string().optional(),
    agent: z.string().optional(),
    mode: z.string().optional(),
    cost: z.number().optional(),
    tokens: z
      .object({
        total: z.number().optional(),
        input: z.number().optional(),
        output: z.number().optional(),
        reasoning: z.number().optional(),
        cache: z
          .object({
            read: z.number().optional(),
            write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    finish: z.string().optional(),
    path: z
      .object({
        cwd: z.string().optional(),
        root: z.string().optional(),
      })
      .optional(),
    summary: z
      .object({
        diffs: z
          .array(
            z.object({
              file: z.string(),
              before: z.string().optional(),
              after: z.string().optional(),
              additions: z.number().optional(),
              deletions: z.number().optional(),
              status: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough();

/** Zod schema for part data blob stored in SQLite data column */
const SqlitePartDataSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    tool: z.string().optional(),
    callID: z.string().optional(),
    state: z
      .object({
        status: z.string().optional(),
        input: z.record(z.string(), z.unknown()).optional(),
        output: z.unknown().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        time: z
          .object({
            start: z.number().optional(),
            end: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    hash: z.string().optional(),
    files: z.array(z.string()).optional(),
    reason: z.string().optional(),
    cost: z.number().optional(),
    tokens: z
      .object({
        total: z.number().optional(),
        input: z.number().optional(),
        output: z.number().optional(),
        reasoning: z.number().optional(),
        cache: z
          .object({
            read: z.number().optional(),
            write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    snapshot: z.string().optional(),
  })
  .passthrough();

/** Todo item from the todo table */
interface TodoItem {
  session_id: string;
  content: string;
  status: string;
  priority: string;
  position: number;
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
function openDb(): { db: SqliteDatabase; close: () => void } | null {
  try {
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
      .sort();

    for (const msgFile of messageFiles) {
      const msgPath = path.join(messageDir, msgFile);
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msgResult = OpenCodeMessageSchema.safeParse(JSON.parse(msgContent));
      if (!msgResult.success) continue;
      const msg = msgResult.data;

      if (msg.role === 'user') {
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
  if (hasSqliteDb()) {
    const sessions = parseSessionsFromSqlite();
    if (sessions.length > 0) return sessions;
  }

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

    const projectRows = db.prepare('SELECT id, worktree FROM project').all() as SqliteProjectRow[];
    const projectMap = new Map(projectRows.map((p: SqliteProjectRow) => [p.id, p.worktree]));

    const sessions: UnifiedSession[] = [];

    for (const row of rows) {
      const cwd = row.directory || projectMap.get(row.project_id) || '';

      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM message WHERE session_id = ?').get(row.id) as
        | { cnt: number }
        | undefined;

      // Get first user message and model info
      let summary = row.title || '';
      let model: string | undefined;
      const firstMsg = db
        .prepare(
          'SELECT m.id, m.data, p.data as part_data FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? AND m.data LIKE \'%"role":"user"%\' AND p.data LIKE \'%"type":"text"%\' ORDER BY m.time_created ASC LIMIT 1',
        )
        .get(row.id) as { id: string; data: string; part_data: string } | undefined;

      if (firstMsg) {
        try {
          const partData = JSON.parse(firstMsg.part_data);
          if (partData.text && (!summary || summary.startsWith('New session'))) {
            summary = partData.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
          }
        } catch {
          /* ignore */
        }
      }

      // Extract model from most recent assistant message
      const modelMsg = db
        .prepare(
          "SELECT data FROM message WHERE session_id = ? AND data LIKE '%\"modelID\"%' ORDER BY time_updated DESC LIMIT 1",
        )
        .get(row.id) as { data: string } | undefined;
      if (modelMsg) {
        try {
          const msgData = JSON.parse(modelMsg.data);
          if (msgData.modelID) {
            model = msgData.modelID;
          }
        } catch {
          /* ignore */
        }
      }

      sessions.push({
        id: row.id,
        source: 'opencode',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines: msgCount?.cnt ?? 0,
        bytes: 0,
        createdAt: new Date(row.time_created),
        updatedAt: new Date(row.time_updated),
        originalPath: OPENCODE_DB_PATH,
        summary: summary?.slice(0, 60) || row.slug || undefined,
        model,
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

      const project = loadProjectInfo(session.projectID);
      const cwd = session.directory || project?.worktree || '';

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
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// ── Tool Extraction ─────────────────────────────────────────────────────────

/** Map OpenCode tool names to canonical names */
const TOOL_NAME_MAP: Record<string, string> = {
  glob: 'glob',
  read: 'read',
  apply_patch: 'apply_patch',
  bash: 'bash',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  write: 'write',
  edit: 'edit',
  grep: 'grep',
};

/**
 * Track file modifications from apply_patch input
 */
function trackPatchFiles(patchText: string, collector: SummaryCollector): void {
  const fileMatches = patchText.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/g) || [];
  for (const match of fileMatches) {
    const filePath = match.replace(/^\*\*\* (?:Add|Update|Delete) File: /, '');
    collector.trackFile(filePath);
  }
}

/**
 * Extract tool usage summaries and file modifications from SQLite parts
 */
function extractToolDataFromParts(
  sessionId: string,
  db: SqliteDatabase,
  config: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);

  // Get all parts for this session, ordered by creation time
  const partRows = db
    .prepare('SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC')
    .all(sessionId) as { data: string }[];

  // Also collect patch parts for file tracking
  const patchParts = db
    .prepare("SELECT data FROM part WHERE session_id = ? AND data LIKE '%\"type\":\"patch\"%' ORDER BY time_created ASC")
    .all(sessionId) as { data: string }[];

  // Track files from patch parts
  for (const row of patchParts) {
    try {
      const partData = JSON.parse(row.data);
      if (partData.files && Array.isArray(partData.files)) {
        for (const f of partData.files) {
          collector.trackFile(f);
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Process tool parts
  for (const row of partRows) {
    try {
      const partDataResult = SqlitePartDataSchema.safeParse(JSON.parse(row.data));
      if (!partDataResult.success) continue;
      // Cast to flexible type for tool data access
      const part = JSON.parse(row.data) as Record<string, unknown>;

      if (part.type !== 'tool' || !part.tool) continue;

      const toolName = TOOL_NAME_MAP[String(part.tool)] || String(part.tool);
      const state = (part.state || {}) as Record<string, unknown>;
      const input = (state.input || {}) as Record<string, unknown>;
      const rawOutput = state.output;
      const output = typeof rawOutput === 'string' ? rawOutput : rawOutput ? JSON.stringify(rawOutput) : undefined;
      const metadata = (state.metadata || {}) as Record<string, unknown>;

      switch (String(part.tool)) {
        case 'bash': {
          const cmd = String(input.command || '');
          if (!cmd) break;
          const exitCode = metadata.exit !== undefined ? Number(metadata.exit) : extractExitCode(output);
          const errored = exitCode !== undefined && exitCode !== 0;
          const stdoutTail = metadata.output ? extractStdoutTail(String(metadata.output), 5) : output ? extractStdoutTail(output, 5) : undefined;
          const description = String(metadata.description || input.description || '');

          collector.add('bash', shellSummary(cmd, output), {
            data: {
              category: 'shell',
              command: cmd,
              ...(exitCode !== undefined ? { exitCode } : {}),
              ...(stdoutTail ? { stdoutTail } : {}),
              ...(errored ? { errored } : {}),
            },
            isError: errored,
          });
          // Track file writes from shell commands
          trackShellFileWrites(cmd, collector);
          break;
        }

        case 'glob': {
          const pattern = String(input.pattern || '');
          const count = metadata.count !== undefined ? Number(metadata.count) : undefined;
          const summary = count !== undefined ? `glob "${pattern}" — ${count} matches` : globSummary(pattern);
          collector.add('glob', summary, {
            data: {
              category: 'glob',
              pattern,
              ...(count !== undefined ? { resultCount: count } : {}),
            },
          });
          break;
        }

        case 'read': {
          const filePath = String(input.filePath || input.path || '');
          if (!filePath) break;
          collector.add('read', fileSummary('read', filePath), {
            data: {
              category: 'read',
              filePath,
            },
          });
          break;
        }

        case 'apply_patch': {
          const patchText = String(input.patchText || input.patch || '');
          // Extract file names from patch
          const fileMatches = patchText.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/g) || [];
          const files = fileMatches.map((m: string) => m.replace(/^\*\*\* (?:Add|Update|Delete) File: /, ''));
          const fileList = files.length > 0 ? files.slice(0, 3).join(', ') : '(patch)';
          const diffStats = patchText ? countDiffStats(patchText) : undefined;

          collector.add('apply_patch', `patch: ${truncate(fileList, 70)}`, {
            data: {
              category: 'edit',
              filePath: files[0] || '(multiple)',
              ...(patchText.length > 0 ? { diff: patchText.slice(0, 2000) } : {}),
              ...(diffStats ? { diffStats } : {}),
            },
            filePath: files[0],
            isWrite: true,
          });
          for (const f of files) collector.trackFile(f);
          break;
        }

        case 'web_search': {
          const query = String(input.query || '');
          collector.add('web_search', searchSummary(query), {
            data: { category: 'search', query },
          });
          break;
        }

        case 'web_fetch': {
          const url = String(input.url || '');
          const preview = output ? truncate(output, 100) : undefined;
          collector.add('web_fetch', `fetch: ${truncate(url, 60)}`, {
            data: {
              category: 'fetch',
              url,
              ...(preview ? { resultPreview: preview } : {}),
            },
          });
          break;
        }

        default: {
          // Generic tool — MCP or unknown
          const params = JSON.stringify(input).slice(0, 100);
          const partTool = String(part.tool);
          const toolLabel = partTool.startsWith('mcp__') ? partTool : toolName;
          collector.add(toolLabel, mcpSummary(toolLabel, params, output), {
            data: {
              category: 'mcp',
              toolName: toolLabel,
              params,
              ...(output ? { result: output.slice(0, 100) } : {}),
            },
          });
        }
      }
    } catch (err) {
      logger.debug('opencode: skipping unparseable part', err);
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Track file writes from shell commands (sed -i, >, tee, mv, cp)
 */
function trackShellFileWrites(cmd: string, collector: SummaryCollector): void {
  const sedMatch = cmd.match(/sed\s+-i[^'"]*\s+[^'"]*\s+['"]?([^\s'"]+)/);
  if (sedMatch) {
    collector.trackFile(sedMatch[1]);
    return;
  }
  const redirectMatch = cmd.match(/>\s*['"]?([^\s;|&'"]+)/);
  if (redirectMatch && !redirectMatch[1].startsWith('>')) {
    collector.trackFile(redirectMatch[1]);
    return;
  }
  const teeMatch = cmd.match(/tee\s+['"]?([^\s;|&'"]+)/);
  if (teeMatch) {
    collector.trackFile(teeMatch[1]);
    return;
  }
  const mvCpMatch = cmd.match(/^(mv|cp)\s+.*\s+['"]?([^\s;|&'"]+)$/);
  if (mvCpMatch) {
    collector.trackFile(mvCpMatch[2]);
  }
}

/**
 * Extract tool data from JSON parts (legacy format)
 */
function extractToolDataFromJsonParts(
  sessionId: string,
  config: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);
  const partBaseDir = path.join(OPENCODE_STORAGE_DIR, 'part');

  // Find all message directories for this session
  const messageDir = path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
  if (!fs.existsSync(messageDir)) return { summaries: [], filesModified: [] };

  const msgFiles = fs
    .readdirSync(messageDir)
    .filter((f) => f.startsWith('msg_') && f.endsWith('.json'))
    .sort();

  for (const msgFile of msgFiles) {
    const msgPath = path.join(messageDir, msgFile);
    try {
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msgResult = OpenCodeMessageSchema.safeParse(JSON.parse(msgContent));
      if (!msgResult.success) continue;
      const msg = msgResult.data;

      // Track files from message diffs (passthrough data not in schema)
      const msgSummary = msg.summary as Record<string, unknown> | undefined;
      const diffs = msgSummary?.diffs as Array<{ file: string }> | undefined;
      if (diffs) {
        for (const diff of diffs) {
          if (diff.file) collector.trackFile(diff.file);
        }
      }

      // Read parts for this message
      const partDir = path.join(partBaseDir, msg.id);
      if (!fs.existsSync(partDir)) continue;

      const partFiles = fs
        .readdirSync(partDir)
        .filter((f) => f.startsWith('prt_') && f.endsWith('.json'))
        .sort();

      for (const partFile of partFiles) {
        const partPath = path.join(partDir, partFile);
        const partContent = fs.readFileSync(partPath, 'utf8');
        const partResult = OpenCodePartSchema.safeParse(JSON.parse(partContent));
        if (!partResult.success) continue;
        // Cast to flexible type for tool data access
        const part = JSON.parse(partContent) as Record<string, unknown>;

        if (part.type !== 'tool' || !part.tool) continue;

        const state = (part.state || {}) as Record<string, unknown>;
        const input = (state.input || {}) as Record<string, unknown>;
        const rawOutput = state.output;
        const output = typeof rawOutput === 'string' ? rawOutput : rawOutput ? JSON.stringify(rawOutput) : undefined;
        const metadata = (state.metadata || {}) as Record<string, unknown>;

        switch (String(part.tool)) {
          case 'bash': {
            const cmd = String(input.command || '');
            if (!cmd) break;
            const exitCode = metadata.exit !== undefined ? Number(metadata.exit) : extractExitCode(output);
            const errored = exitCode !== undefined && exitCode !== 0;
            const stdoutTail = metadata.output ? extractStdoutTail(String(metadata.output), 5) : undefined;

            collector.add('bash', shellSummary(cmd, output), {
              data: {
                category: 'shell',
                command: cmd,
                ...(exitCode !== undefined ? { exitCode } : {}),
                ...(stdoutTail ? { stdoutTail } : {}),
                ...(errored ? { errored } : {}),
              },
              isError: errored,
            });
            trackShellFileWrites(cmd, collector);
            break;
          }
          case 'glob': {
            const pattern = String(input.pattern || '');
            const count = metadata.count !== undefined ? Number(metadata.count) : undefined;
            const summary = count !== undefined ? `glob "${pattern}" — ${count} matches` : globSummary(pattern);
            collector.add('glob', summary, {
              data: { category: 'glob', pattern, ...(count !== undefined ? { resultCount: count } : {}) },
            });
            break;
          }
          case 'read': {
            const filePath = String(input.filePath || input.path || '');
            if (!filePath) break;
            collector.add('read', fileSummary('read', filePath), {
              data: { category: 'read', filePath },
            });
            break;
          }
          case 'apply_patch': {
            const patchText = String(input.patchText || input.patch || '');
            const fileMatches = patchText.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/g) || [];
            const files = fileMatches.map((m: string) => m.replace(/^\*\*\* (?:Add|Update|Delete) File: /, ''));
            const fileList = files.length > 0 ? files.slice(0, 3).join(', ') : '(patch)';
            const diffStats = patchText ? countDiffStats(patchText) : undefined;

            collector.add('apply_patch', `patch: ${truncate(fileList, 70)}`, {
              data: {
                category: 'edit',
                filePath: files[0] || '(multiple)',
                ...(patchText.length > 0 ? { diff: patchText.slice(0, 2000) } : {}),
                ...(diffStats ? { diffStats } : {}),
              },
              filePath: files[0],
              isWrite: true,
            });
            for (const f of files) collector.trackFile(f);
            break;
          }
          default: {
            const params = JSON.stringify(input).slice(0, 100);
            const partTool = String(part.tool);
            collector.add(partTool, mcpSummary(partTool, params, output), {
              data: {
                category: 'mcp',
                toolName: partTool,
                params,
                ...(output ? { result: output.slice(0, 100) } : {}),
              },
            });
          }
        }
      }
    } catch (err) {
      logger.debug('opencode: failed to process JSON message parts', msgFile, err);
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

// ── Session Notes Extraction ────────────────────────────────────────────────

/**
 * Extract session notes (model, tokens, reasoning) from SQLite
 */
function extractSessionNotesFromSqlite(sessionId: string, db: SqliteDatabase): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];
  let totalCost = 0;

  const msgRows = db
    .prepare('SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC')
    .all(sessionId) as { data: string }[];

  for (const row of msgRows) {
    try {
      const msgData = SqliteMsgDataSchema.parse(JSON.parse(row.data));

      // Model info (take from first assistant message that has it)
      if (msgData.role === 'assistant' && msgData.modelID && !notes.model) {
        notes.model = msgData.modelID;
      }

      // Token usage (accumulate — take last value for display)
      if (msgData.tokens) {
        notes.tokenUsage = {
          input: (notes.tokenUsage?.input || 0) + (msgData.tokens.input || 0),
          output: (notes.tokenUsage?.output || 0) + (msgData.tokens.output || 0),
        };
        if (msgData.tokens.reasoning && msgData.tokens.reasoning > 0) {
          notes.thinkingTokens = (notes.thinkingTokens || 0) + msgData.tokens.reasoning;
        }
        if (msgData.tokens.cache) {
          notes.cacheTokens = {
            read: (notes.cacheTokens?.read || 0) + (msgData.tokens.cache.read || 0),
            creation: (notes.cacheTokens?.creation || 0) + (msgData.tokens.cache.write || 0),
          };
        }
      }

      // Cost tracking
      if (msgData.cost && msgData.cost > 0) {
        totalCost += msgData.cost;
      }
    } catch {
      /* ignore */
    }
  }

  // Extract reasoning from parts
  const partRows = db
    .prepare("SELECT data FROM part WHERE session_id = ? AND data LIKE '%\"type\":\"reasoning\"%' ORDER BY time_created ASC")
    .all(sessionId) as { data: string }[];

  for (const row of partRows) {
    if (reasoning.length >= 10) break;
    try {
      const partData = JSON.parse(row.data);
      if (partData.type === 'reasoning' && partData.text && partData.text.length > 20) {
        const firstLine = partData.text.split(/[.\n]/)[0]?.trim();
        if (firstLine) reasoning.push(truncate(firstLine, 200));
      }
    } catch {
      /* ignore */
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;

  // Active time: calculate from first to last message timestamps
  const firstMsg = db
    .prepare('SELECT time_created FROM message WHERE session_id = ? ORDER BY time_created ASC LIMIT 1')
    .get(sessionId) as { time_created: number } | undefined;
  const lastMsg = db
    .prepare('SELECT time_updated FROM message WHERE session_id = ? ORDER BY time_updated DESC LIMIT 1')
    .get(sessionId) as { time_updated: number } | undefined;

  if (firstMsg && lastMsg) {
    notes.activeTimeMs = lastMsg.time_updated - firstMsg.time_created;
  }

  return notes;
}

/**
 * Extract session notes from JSON files (legacy)
 */
function extractSessionNotesFromJson(sessionId: string): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  const messageDir = path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
  if (!fs.existsSync(messageDir)) return notes;

  const msgFiles = fs
    .readdirSync(messageDir)
    .filter((f) => f.startsWith('msg_') && f.endsWith('.json'))
    .sort();

  for (const msgFile of msgFiles) {
    try {
      const msgPath = path.join(messageDir, msgFile);
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msgResult = OpenCodeMessageSchema.safeParse(JSON.parse(msgContent));
      if (!msgResult.success) continue;
      const msg = msgResult.data;

      if (msg.role === 'assistant' && (msg as Record<string, unknown>).modelID && !notes.model) {
        notes.model = (msg as Record<string, unknown>).modelID as string;
      }

      // Read parts for reasoning
      const partDir = path.join(OPENCODE_STORAGE_DIR, 'part', msg.id);
      if (!fs.existsSync(partDir)) continue;

      const partFiles = fs
        .readdirSync(partDir)
        .filter((f) => f.startsWith('prt_') && f.endsWith('.json'))
        .sort();

      for (const partFile of partFiles) {
        if (reasoning.length >= 10) break;
        const partPath = path.join(partDir, partFile);
        const partContent = fs.readFileSync(partPath, 'utf8');
        try {
          const partData = JSON.parse(partContent);
          if (partData.type === 'reasoning' && partData.text && partData.text.length > 20) {
            const firstLine = partData.text.split(/[.\n]/)[0]?.trim();
            if (firstLine) reasoning.push(truncate(firstLine, 200));
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

// ── Todo Extraction ─────────────────────────────────────────────────────────

/**
 * Extract pending todos from SQLite
 */
function extractTodos(sessionId: string, db: SqliteDatabase): string[] {
  try {
    const rows = db
      .prepare("SELECT content, status, priority FROM todo WHERE session_id = ? ORDER BY position ASC")
      .all(sessionId) as TodoItem[];
    return rows
      .filter((t) => t.status !== 'completed')
      .map((t) => `[${t.priority}] ${t.content}`);
  } catch {
    return [];
  }
}

// ── Main Context Extraction ─────────────────────────────────────────────────

/**
 * Read messages from SQLite for conversation display
 */
function readConversationMessagesFromSqlite(sessionId: string, db: SqliteDatabase): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  const msgRows = db
    .prepare('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC')
    .all(sessionId) as SqliteMessageRow[];

  for (const msgRow of msgRows) {
    try {
      const msgData = SqliteMsgDataSchema.parse(JSON.parse(msgRow.data));
      const role: 'user' | 'assistant' = msgData.role === 'user' ? 'user' : 'assistant';

      // Get text parts for this message
      const partRows = db
        .prepare("SELECT data FROM part WHERE message_id = ? AND data LIKE '%\"type\":\"text\"%' ORDER BY time_created ASC")
        .all(msgRow.id) as { data: string }[];

      let text = '';
      for (const partRow of partRows) {
        try {
          const partData = JSON.parse(partRow.data);
          if (partData.type === 'text' && partData.text) {
            text += partData.text + '\n';
          }
        } catch {
          /* ignore */
        }
      }

      if (text.trim()) {
        messages.push({
          role,
          content: text.trim(),
          timestamp: new Date(msgRow.time_created),
        });
      }
    } catch {
      /* ignore */
    }
  }

  return messages;
}

/**
 * Read conversation messages from JSON files (legacy)
 */
function readConversationMessagesFromJson(sessionId: string): ConversationMessage[] {
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
  }

  return messages;
}

/**
 * Extract context from an OpenCode session for cross-tool continuation
 */
export async function extractOpenCodeContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  let toolSummaries: ToolUsageSummary[] = [];
  let filesModified: string[] = [];
  let sessionNotes: SessionNotes = {};
  let pendingTasks: string[] = [];
  let allMessages: ConversationMessage[] = [];

  if (hasSqliteDb()) {
    const handle = openDb();
    if (handle) {
      const { db, close } = handle;
      try {
        // Extract rich tool data from parts
        const toolData = extractToolDataFromParts(session.id, db, resolvedConfig);
        toolSummaries = toolData.summaries;
        filesModified = toolData.filesModified;

        // Extract session notes (model, tokens, reasoning)
        sessionNotes = extractSessionNotesFromSqlite(session.id, db);

        // Extract pending todos
        pendingTasks = extractTodos(session.id, db);

        // Read conversation messages
        allMessages = readConversationMessagesFromSqlite(session.id, db);
      } finally {
        close();
      }
    }
  }

  // Fallback to JSON if no SQLite data
  if (allMessages.length === 0) {
    allMessages = readConversationMessagesFromJson(session.id);
    if (toolSummaries.length === 0) {
      const toolData = extractToolDataFromJsonParts(session.id, resolvedConfig);
      toolSummaries = toolData.summaries;
      filesModified = toolData.filesModified;
    }
    if (!sessionNotes.model) {
      sessionNotes = extractSessionNotesFromJson(session.id);
    }
  }

  // Trim messages to configured limit
  const trimmed = allMessages.slice(-resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(session, trimmed, filesModified, pendingTasks, toolSummaries, sessionNotes, resolvedConfig);

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

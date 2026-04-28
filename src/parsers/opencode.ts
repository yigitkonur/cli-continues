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
  SessionEvent,
  SessionNotes,
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
import { countDiffStats, extractStdoutTail } from '../utils/diff.js';
import { findFiles, listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import {
  extractExitCode,
  fetchSummary,
  fileSummary,
  globSummary,
  grepSummary,
  mcpSummary,
  SummaryCollector,
  searchSummary,
  shellSummary,
  truncate,
} from '../utils/tool-summarizer.js';

/** Minimal typed interface for node:sqlite DatabaseSync */
interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

const OpenCodeTokenUsageSchema = z
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
  .optional();

/** Zod schema for message data blob stored in SQLite data column */
const SqliteMsgDataSchema = z
  .object({
    role: z.string(),
    modelID: z.string().optional(),
    providerID: z.string().optional(),
    cost: z.number().optional(),
    tokens: OpenCodeTokenUsageSchema,
  })
  .passthrough();
type OpenCodeTokenUsage = z.infer<typeof OpenCodeTokenUsageSchema>;

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

function getOpenCodeDbPaths(): string[] {
  if (process.env.OPENCODE_DB) {
    return [process.env.OPENCODE_DB];
  }

  const baseDir = getOpenCodeBaseDir();
  const defaultDbPath = path.join(baseDir, 'opencode.db');
  const dbPaths: string[] = [];
  if (fs.existsSync(defaultDbPath)) {
    dbPaths.push(defaultDbPath);
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
    for (const channelDbPath of channelDbPaths) {
      if (!dbPaths.includes(channelDbPath)) {
        dbPaths.push(channelDbPath);
      }
    }
  } catch (err) {
    logger.debug('opencode: failed to inspect channel SQLite DB variants', baseDir, err);
  }

  return dbPaths;
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
  const metadata = getRecordValue(state, 'metadata');
  const status = typeof state.status === 'string' ? state.status : undefined;
  const outputString = stringifyToolValue(state.output);
  const errorString = stringifyToolValue(state.error);
  const fullResult = outputString && outputString.length > 0 ? outputString : errorString;
  const resultPreview = fullResult ? previewUnknown(fullResult) : '';
  const argPreview = previewUnknown(state.input, 120);
  const exitCode = firstNumber(metadata, ['exit', 'exitCode']);
  const metadataIndicatesError = exitCode !== undefined && exitCode !== 0;

  const detailBits = [argPreview, resultPreview].filter(Boolean);
  const statusLabel = status ? ` ${status}` : '';
  const content = [`[tool:${toolName}${statusLabel}]`, ...detailBits].join(' ').trim();

  const summaryBits = [status, argPreview && `input=${argPreview}`, resultPreview && `result=${resultPreview}`].filter(
    Boolean,
  );
  const summary = summaryBits.length > 0 ? summaryBits.join(' | ') : 'invoked';
  let success: boolean | undefined;
  if (status === 'error' || metadataIndicatesError) success = false;
  else if (status === 'completed') success = true;

  const normalizedArguments = normalizeToolArguments(state.input);

  return {
    content,
    toolName,
    summary,
    isError: success === false,
    toolCall: {
      name: toolName,
      ...(typeof partData.callID === 'string' ? { id: partData.callID } : {}),
      ...(normalizedArguments ? { arguments: normalizedArguments } : {}),
      ...(fullResult ? { result: fullResult } : {}),
      ...(success !== undefined ? { success } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
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

interface OpenCodeToolData {
  summaries: ToolUsageSummary[];
  filesModified: string[];
}

function getRecordValue(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function stringifyToolValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return undefined;

  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.debug('opencode: failed to stringify tool value', err);
    return undefined;
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function extractPatchFiles(patchText: string): string[] {
  const files = new Set<string>();
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) {
    const filePath = match[1]?.trim();
    if (filePath) files.add(filePath);
  }

  for (const match of patchText.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gmu)) {
    const filePath = match[1]?.trim();
    if (filePath && filePath !== '/dev/null') files.add(filePath);
  }

  return Array.from(files);
}

function trackPatchFiles(patchText: string, collector: SummaryCollector): string[] {
  const files = extractPatchFiles(patchText);
  for (const filePath of files) collector.trackFile(filePath);
  return files;
}

function trackPatchPart(partData: Record<string, unknown>, collector: SummaryCollector): void {
  const files = Array.isArray(partData.files)
    ? partData.files.filter((file): file is string => typeof file === 'string')
    : [];
  for (const filePath of files) collector.trackFile(filePath);

  const patchText =
    firstString(partData, ['patch', 'diff', 'text']) ||
    firstString(getRecordValue(partData, 'state'), ['patch', 'diff', 'output']);
  if (patchText) trackPatchFiles(patchText, collector);
}

function trackShellFileWrites(command: string, collector: SummaryCollector): void {
  const redirectMatch = command.match(/(?:^|\s)(?:>|>>)\s*['"]?([^\s;|&'"]+)/u);
  if (redirectMatch?.[1]) {
    collector.trackFile(redirectMatch[1]);
    return;
  }

  const teeMatch = command.match(/(?:^|\s)tee\s+(?:-[a-zA-Z]+\s+)*['"]?([^\s;|&'"]+)/u);
  if (teeMatch?.[1]) {
    collector.trackFile(teeMatch[1]);
    return;
  }

  const mvCpMatch = command.match(/^(?:mv|cp)\s+.+\s+['"]?([^\s;|&'"]+)$/u);
  if (mvCpMatch?.[1]) collector.trackFile(mvCpMatch[1]);
}

function summarizeOpenCodeToolPart(partData: Record<string, unknown>, collector: SummaryCollector): void {
  if (partData.type === 'patch') {
    trackPatchPart(partData, collector);
    return;
  }

  if (partData.type !== 'tool' || typeof partData.tool !== 'string') return;

  const toolName = partData.tool;
  const state = getRecordValue(partData, 'state');
  const input = getRecordValue(state, 'input');
  const metadata = getRecordValue(state, 'metadata');
  const status = typeof state.status === 'string' ? state.status : undefined;
  const output = stringifyToolValue(state.output) ?? stringifyToolValue(state.error);
  const outputPreview = output ? truncate(normalizeWhitespace(output), 100) : undefined;

  switch (toolName) {
    case 'bash': {
      const command = firstString(input, ['command', 'cmd']);
      if (!command) return;

      const exitCode = firstNumber(metadata, ['exit', 'exitCode']) ?? extractExitCode(output);
      const errored = status === 'error' || (exitCode !== undefined && exitCode !== 0);
      const stdoutTail = output ? extractStdoutTail(output, 5) : undefined;

      const summary = errored ? `${shellSummary(command, output)} (error)` : shellSummary(command, output);
      collector.add('bash', summary, {
        data: {
          category: 'shell',
          command,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(stdoutTail && !errored ? { stdoutTail } : {}),
          ...(errored ? { errored, errorMessage: outputPreview } : {}),
        },
        isError: errored,
      });
      trackShellFileWrites(command, collector);
      break;
    }

    case 'glob': {
      const pattern = firstString(input, ['pattern', 'path', 'query']);
      const resultCount = firstNumber(metadata, ['count', 'resultCount']);
      collector.add(
        'glob',
        resultCount !== undefined ? `glob "${pattern}" - ${resultCount} matches` : globSummary(pattern),
        {
          data: { category: 'glob', pattern, ...(resultCount !== undefined ? { resultCount } : {}) },
        },
      );
      break;
    }

    case 'grep': {
      const pattern = firstString(input, ['pattern', 'query', 'regex']);
      const targetPath = firstString(input, ['path', 'include', 'filePath']);
      const matchCount = firstNumber(metadata, ['count', 'matchCount']);
      collector.add('grep', grepSummary(pattern, targetPath), {
        data: {
          category: 'grep',
          pattern,
          ...(targetPath ? { targetPath } : {}),
          ...(matchCount !== undefined ? { matchCount } : {}),
        },
      });
      break;
    }

    case 'read': {
      const filePath = firstString(input, ['filePath', 'path']);
      if (!filePath) return;
      const summary = status ? `${fileSummary('read', filePath)} (${status})` : fileSummary('read', filePath);
      collector.add('read', summary, {
        data: { category: 'read', filePath },
      });
      break;
    }

    case 'write': {
      const filePath = firstString(input, ['filePath', 'path']);
      if (!filePath) return;
      collector.add('write', fileSummary('write', filePath), {
        data: { category: 'write', filePath },
        filePath,
        isWrite: true,
      });
      break;
    }

    case 'edit':
    case 'apply_patch': {
      const patchText =
        firstString(input, ['patchText', 'patch', 'diff']) || firstString(partData, ['patch', 'diff', 'text']);
      const files = patchText ? trackPatchFiles(patchText, collector) : [];
      const filePath = firstString(input, ['filePath', 'path']) || files[0] || '(multiple)';
      const diffStats = patchText ? countDiffStats(patchText) : undefined;
      collector.add(
        toolName,
        patchText ? `patch: ${truncate(files.slice(0, 3).join(', ') || filePath, 70)}` : fileSummary('edit', filePath),
        {
          data: {
            category: 'edit',
            filePath,
            ...(patchText ? { diff: patchText.slice(0, 2000) } : {}),
            ...(diffStats ? { diffStats } : {}),
          },
          filePath: filePath === '(multiple)' ? undefined : filePath,
          isWrite: filePath !== '(multiple)',
        },
      );
      break;
    }

    case 'web_search': {
      const query = firstString(input, ['query', 'search']);
      collector.add('web_search', searchSummary(query), {
        data: { category: 'search', query, ...(outputPreview ? { resultPreview: outputPreview } : {}) },
      });
      break;
    }

    case 'web_fetch': {
      const url = firstString(input, ['url']);
      collector.add('web_fetch', fetchSummary(url), {
        data: { category: 'fetch', url, ...(outputPreview ? { resultPreview: outputPreview } : {}) },
      });
      break;
    }

    default: {
      const params = stringifyToolValue(input);
      collector.add(toolName, mcpSummary(toolName, params ? truncate(params, 100) : '', outputPreview), {
        data: {
          category: 'mcp',
          toolName,
          ...(params ? { params: truncate(params, 100) } : {}),
          ...(outputPreview ? { result: outputPreview } : {}),
        },
        isError: status === 'error',
      });
    }
  }
}

/**
 * Check if SQLite DB exists and is usable
 */
function hasSqliteDb(): boolean {
  return getOpenCodeDbPaths().some((dbPath) => fs.existsSync(dbPath));
}

/**
 * Open SQLite database using node:sqlite (built-in)
 */
function openDb(dbPath: string): { db: SqliteDatabase; close: () => void } | null {
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
  const sessionsById = new Map<string, UnifiedSession>();

  for (const dbPath of getOpenCodeDbPaths()) {
    const handle = openDb(dbPath);
    if (!handle) continue;

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

        const nextSession: UnifiedSession = {
          id: row.id,
          source: 'opencode',
          cwd,
          repo: extractRepoFromCwd(cwd),
          lines: msgCount?.cnt ?? 0,
          bytes: 0, // SQLite doesn't have per-session file size
          createdAt: new Date(row.time_created),
          updatedAt: new Date(row.time_updated),
          originalPath: dbPath,
          summary: summary?.slice(0, 60) || row.slug || undefined,
          model: undefined,
        };

        const existing = sessionsById.get(nextSession.id);
        if (!existing || existing.updatedAt.getTime() < nextSession.updatedAt.getTime()) {
          sessionsById.set(nextSession.id, nextSession);
        }
      }
    } catch (err) {
      logger.debug('opencode: SQLite session query failed', dbPath, err);
    } finally {
      close();
    }
  }

  return Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
  for (const dbPath of getOpenCodeDbPaths()) {
    const handle = openDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const msgRows = db
        .prepare(
          'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC',
        )
        .all(sessionId) as SqliteMessageRow[];
      if (msgRows.length === 0) continue;

      const messages: ConversationMessage[] = [];

      for (const msgRow of msgRows) {
        const msgDataResult = SqliteMsgDataSchema.safeParse(JSON.parse(msgRow.data));
        if (!msgDataResult.success) continue;
        const role: 'user' | 'assistant' = msgDataResult.data.role === 'user' ? 'user' : 'assistant';

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
      logger.debug('opencode: SQLite message query failed for session', dbPath, sessionId, err);
    } finally {
      close();
    }
  }

  return [];
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
 * Extract rich OpenCode tool summaries and modified files from SQLite or JSON storage.
 */
function extractOpenCodeToolData(sessionId: string, config: VerbosityConfig): OpenCodeToolData {
  if (hasSqliteDb()) {
    const sqliteData = extractOpenCodeToolDataFromSqlite(sessionId, config);
    if (sqliteData.summaries.length > 0 || sqliteData.filesModified.length > 0) {
      return sqliteData;
    }
  }

  return extractOpenCodeToolDataFromJson(sessionId, config);
}

function addSessionEditSummaryFromSqlite(sessionId: string, db: SqliteDatabase, collector: SummaryCollector): boolean {
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

  return Boolean(sessionRow);
}

function extractOpenCodeToolDataFromSqlite(sessionId: string, config: VerbosityConfig): OpenCodeToolData {
  for (const dbPath of getOpenCodeDbPaths()) {
    const collector = new SummaryCollector(config);
    const handle = openDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const foundSession = addSessionEditSummaryFromSqlite(sessionId, db, collector);

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
        if (!partDataResult.success) continue;
        summarizeOpenCodeToolPart(partDataResult.data, collector);
      }

      if (foundSession || partRows.length > 0) {
        return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
      }
    } catch (err) {
      logger.debug('opencode: SQLite tool summary query failed', dbPath, sessionId, err);
    } finally {
      close();
    }
  }

  return { summaries: [], filesModified: [] };
}

function addSessionEditSummaryFromJson(sessionId: string, collector: SummaryCollector): void {
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
}

function extractOpenCodeToolDataFromJson(sessionId: string, config: VerbosityConfig): OpenCodeToolData {
  const collector = new SummaryCollector(config);
  addSessionEditSummaryFromJson(sessionId, collector);

  const messageDir = path.join(getOpenCodeStorageDir(), 'message', sessionId);
  if (!fs.existsSync(messageDir)) {
    return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
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
        if (!partResult.success) continue;
        summarizeOpenCodeToolPart(partResult.data, collector);
      }
    }
  } catch (err) {
    logger.debug('opencode: failed to read JSON tool-part summaries', sessionId, err);
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

function addTokenUsage(notes: SessionNotes, tokens: OpenCodeTokenUsage): void {
  if (!tokens) return;

  notes.tokenUsage = {
    input: (notes.tokenUsage?.input ?? 0) + (tokens.input ?? 0),
    output: (notes.tokenUsage?.output ?? 0) + (tokens.output ?? 0),
  };

  if (tokens.reasoning && tokens.reasoning > 0) {
    notes.thinkingTokens = (notes.thinkingTokens ?? 0) + tokens.reasoning;
  }

  if (tokens.cache) {
    notes.cacheTokens = {
      read: (notes.cacheTokens?.read ?? 0) + (tokens.cache.read ?? 0),
      creation: (notes.cacheTokens?.creation ?? 0) + (tokens.cache.write ?? 0),
    };
  }
}

function addReasoningHighlight(partData: Record<string, unknown>, reasoning: string[], maxHighlights: number): void {
  if (reasoning.length >= maxHighlights || partData.type !== 'reasoning') return;

  const text = firstString(partData, ['text', 'summary', 'content']);
  if (text.length <= 20) return;

  const firstLine = text.split(/[.\n]/u)[0]?.trim();
  if (firstLine) reasoning.push(truncate(firstLine, 200));
}

function extractSessionNotesFromSqlite(sessionId: string): SessionNotes | undefined {
  for (const dbPath of getOpenCodeDbPaths()) {
    const handle = openDb(dbPath);
    if (!handle) continue;

    const notes: SessionNotes = {};
    const reasoning: string[] = [];
    const { db, close } = handle;

    try {
      const msgRows = db
        .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
        .all(sessionId) as Array<{ id: string; time_created: number; data: string }>;
      if (msgRows.length === 0) continue;

      for (const row of msgRows) {
        let rawMsgData: unknown;
        try {
          rawMsgData = JSON.parse(row.data);
        } catch (err) {
          logger.debug('opencode: failed to parse SQLite message notes JSON', dbPath, row.id, err);
          continue;
        }

        const msgDataResult = SqliteMsgDataSchema.safeParse(rawMsgData);
        if (!msgDataResult.success) continue;
        const msgData = msgDataResult.data;

        if (msgData.role === 'assistant' && msgData.modelID && !notes.model) {
          notes.model = msgData.modelID;
        }
        addTokenUsage(notes, msgData.tokens);
      }

      const firstCreated = msgRows[0]?.time_created;
      const lastCreated = msgRows[msgRows.length - 1]?.time_created;
      if (firstCreated !== undefined && lastCreated !== undefined && lastCreated >= firstCreated) {
        notes.activeTimeMs = lastCreated - firstCreated;
      }

      const partRows = db
        .prepare(
          'SELECT data FROM part WHERE session_id = ? AND data LIKE \'%"type":"reasoning"%\' ORDER BY time_created ASC, id ASC',
        )
        .all(sessionId) as SqlitePartRow[];
      for (const partRow of partRows) {
        let rawPartData: unknown;
        try {
          rawPartData = JSON.parse(partRow.data);
        } catch (err) {
          logger.debug('opencode: failed to parse SQLite reasoning part JSON', dbPath, sessionId, err);
          continue;
        }

        const partDataResult = SqlitePartDataSchema.safeParse(rawPartData);
        if (partDataResult.success) {
          addReasoningHighlight(partDataResult.data, reasoning, 10);
        }
      }

      if (reasoning.length > 0) notes.reasoning = reasoning;
      const sessionRow = db.prepare('SELECT project_id, slug, version FROM session WHERE id = ?').get(sessionId) as
        | { project_id?: string; slug?: string; version?: string }
        | undefined;
      if (sessionRow) {
        notes.sourceMetadata = {
          ...(sessionRow.slug ? { slug: sessionRow.slug } : {}),
          ...(sessionRow.version ? { version: sessionRow.version } : {}),
          ...(sessionRow.project_id ? { projectId: sessionRow.project_id } : {}),
        };
      }
      return Object.keys(notes).length > 0 ? notes : undefined;
    } catch (err) {
      logger.debug('opencode: failed to extract SQLite session notes', dbPath, sessionId, err);
    } finally {
      close();
    }
  }

  return undefined;
}

function extractSessionNotesFromJson(sessionId: string): SessionNotes | undefined {
  const messageDir = path.join(getOpenCodeStorageDir(), 'message', sessionId);
  if (!fs.existsSync(messageDir)) return undefined;

  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  try {
    const messageFiles = fs
      .readdirSync(messageDir)
      .filter((fileName) => fileName.startsWith('msg_') && fileName.endsWith('.json'))
      .sort();

    let firstCreated: number | undefined;
    let lastCreated: number | undefined;
    for (const messageFile of messageFiles) {
      const messagePath = path.join(messageDir, messageFile);
      const messageContent = fs.readFileSync(messagePath, 'utf8');
      const messageResult = OpenCodeMessageSchema.safeParse(JSON.parse(messageContent));
      if (!messageResult.success) continue;
      const message = messageResult.data;
      firstCreated ??= message.time.created;
      lastCreated = message.time.created;

      const rawMessage = message as Record<string, unknown>;
      const modelID = firstString(rawMessage, ['modelID']);
      if (message.role === 'assistant' && modelID && !notes.model) {
        notes.model = modelID;
      }

      const tokenResult = OpenCodeTokenUsageSchema.safeParse(rawMessage.tokens);
      if (tokenResult.success) addTokenUsage(notes, tokenResult.data);

      const partDir = path.join(getOpenCodeStorageDir(), 'part', message.id);
      if (!fs.existsSync(partDir)) continue;

      const partFiles = fs
        .readdirSync(partDir)
        .filter((fileName) => fileName.startsWith('prt_') && fileName.endsWith('.json'))
        .sort();
      for (const partFile of partFiles) {
        const partContent = fs.readFileSync(path.join(partDir, partFile), 'utf8');
        const partResult = OpenCodePartSchema.safeParse(JSON.parse(partContent));
        if (partResult.success) addReasoningHighlight(partResult.data, reasoning, 10);
      }
    }

    if (firstCreated !== undefined && lastCreated !== undefined && lastCreated >= firstCreated) {
      notes.activeTimeMs = lastCreated - firstCreated;
    }

    for (const projectDir of listSubdirectories(path.join(getOpenCodeStorageDir(), 'session'))) {
      const sessionFile = path.join(projectDir, `${sessionId}.json`);
      if (!fs.existsSync(sessionFile)) continue;
      const content = fs.readFileSync(sessionFile, 'utf8');
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(content);
      } catch (err) {
        // One malformed session file shouldn't lose the reasoning/token/activeTime
        // already extracted from the message dir for this session.
        logger.debug('opencode: skipping malformed session file', sessionFile, err);
        continue;
      }
      const result = OpenCodeSessionSchema.safeParse(parsedJson);
      if (result.success) {
        notes.sourceMetadata = {
          ...(result.data.slug ? { slug: result.data.slug } : {}),
          ...(result.data.version ? { version: result.data.version } : {}),
          ...(result.data.projectID ? { projectId: result.data.projectID } : {}),
        };
      }
      break;
    }
  } catch (err) {
    logger.debug('opencode: failed to extract JSON session notes', sessionId, err);
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return Object.keys(notes).length > 0 ? notes : undefined;
}

function extractOpenCodeSessionNotes(sessionId: string): SessionNotes | undefined {
  return extractSessionNotesFromSqlite(sessionId) ?? extractSessionNotesFromJson(sessionId);
}

function extractPendingTasksFromSqlite(sessionId: string): string[] {
  for (const dbPath of getOpenCodeDbPaths()) {
    const handle = openDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const rows = db
        .prepare('SELECT content, status, priority FROM todo WHERE session_id = ? ORDER BY position ASC')
        .all(sessionId) as Array<{ content: string; status: string; priority: string }>;
      return rows.filter((task) => task.status !== 'completed').map((task) => `[${task.priority}] ${task.content}`);
    } catch (err) {
      logger.debug('opencode: failed to extract SQLite pending tasks', dbPath, sessionId, err);
    } finally {
      close();
    }
  }

  return [];
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
  const toolData = extractOpenCodeToolData(session.id, resolvedConfig);
  const filesModified = toolData.filesModified;
  const pendingTasks = extractPendingTasksFromSqlite(session.id);
  const sessionNotes = extractOpenCodeSessionNotes(session.id);

  const trimmed = trimMessages(recentMessages, resolvedConfig.recentMessages);
  const timeline = buildOpenCodeTimeline(trimmed, resolvedConfig.handoff.timelineWindow);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolData.summaries,
    sessionNotes,
    resolvedConfig,
    'inline',
    timeline,
  );

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries: toolData.summaries,
    ...(sessionNotes ? { sessionNotes } : {}),
    timeline,
    markdown,
  };
}

function buildOpenCodeTimeline(messages: ConversationMessage[], timelineWindow?: number): SessionEvent[] {
  // Build per-message clusters of (one message event + N tool_call events) so we can
  // budget the tool events without dropping any preserved user/assistant message.
  type Cluster = { message: SessionEvent; tools: SessionEvent[] };
  const clusters: Cluster[] = [];
  let sequence = 0;

  for (const message of messages) {
    const messageEvent: SessionEvent = {
      kind: 'message',
      sequence: sequence++,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      sourceId: message.sourceId,
    };
    const toolEvents: SessionEvent[] = [];
    for (const toolCall of message.toolCalls ?? []) {
      toolEvents.push({
        kind: 'tool_call',
        sequence: sequence++,
        timestamp: message.timestamp,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        status: toolCall.success === undefined ? undefined : toolCall.success ? 'success' : 'error',
        arguments: toolCall.arguments,
        result: toolCall.result,
        metadata: toolCall.metadata,
      });
    }
    clusters.push({ message: messageEvent, tools: toolEvents });
  }

  const totalEvents = clusters.reduce((sum, cluster) => sum + 1 + cluster.tools.length, 0);

  // When the consumer's tail-slice (timelineWindow) cannot fit every event we built,
  // budget tool events around the messages so the slice still contains the preserved
  // user prompts. Each cluster keeps its message event; remaining budget is distributed
  // round-robin over tool events from the latest cluster backwards.
  if (timelineWindow !== undefined && timelineWindow > 0 && totalEvents > timelineWindow) {
    const messageCount = clusters.length;
    if (messageCount > timelineWindow) {
      // Even the message events alone exceed the window; keep the most recent
      // clusters (already preserves the latest user prompt) and drop all tool
      // events so the consumer's tail-slice cannot evict messages.
      const tail = clusters.slice(-timelineWindow);
      tail.forEach((cluster) => {
        cluster.tools = [];
      });
      clusters.length = 0;
      clusters.push(...tail);
      const trimmedEvents: SessionEvent[] = [];
      for (const cluster of clusters) trimmedEvents.push(cluster.message);
      return trimmedEvents;
    }
    let toolBudget = Math.max(0, timelineWindow - messageCount);
    // Walk clusters from newest to oldest, allocating tool slots so trailing tool
    // activity is preserved alongside the user prompts that introduced it.
    const allowed: number[] = clusters.map(() => 0);
    for (let i = clusters.length - 1; i >= 0 && toolBudget > 0; i--) {
      const take = Math.min(toolBudget, clusters[i].tools.length);
      allowed[i] = take;
      toolBudget -= take;
    }
    for (let i = 0; i < clusters.length; i++) {
      // Keep the most recent tool calls within each cluster (the trailing ones the
      // assistant emitted just before the next message). slice(-0) === slice(0)
      // returns the full array, so guard the zero-budget case explicitly.
      clusters[i].tools = allowed[i] > 0 ? clusters[i].tools.slice(-allowed[i]) : [];
    }
  }

  const events: SessionEvent[] = [];
  for (const cluster of clusters) {
    events.push(cluster.message);
    for (const tool of cluster.tools) events.push(tool);
  }
  return events;
}

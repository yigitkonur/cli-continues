import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  SessionParseOptions,
  ToolCall,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import { classifyToolName, type SessionSource, type ToolSampleCategory } from '../types/tool-names.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { matchesCwd } from '../utils/slug.js';
import {
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

const require = createRequire(import.meta.url);

const CRUSH_SOURCE: SessionSource = 'crush';
const CRUSH_DB_FILE = 'crush.db';
const CRUSH_DATA_DIR = '.crush';
const GENERIC_TITLES = new Set(['', 'new session', 'untitled', 'untitled session']);

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

interface CrushDbCandidate {
  dbPath: string;
  cwd: string;
}

interface CrushSchema {
  sessionColumns: ReadonlySet<string>;
  messageColumns: ReadonlySet<string>;
}

interface CrushSessionRow {
  id: string;
  title: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  sessionCreatedAt: number | undefined;
  sessionUpdatedAt: number | undefined;
  firstMessageAt: number | undefined;
  lastMessageAt: number | undefined;
  messageCount: number;
  latestModel: string | undefined;
  latestProvider: string | undefined;
}

interface CrushMessageRow {
  id: string;
  role: string;
  parts: string;
  createdAt: number | undefined;
  model: string | undefined;
  provider: string | undefined;
  isSummaryMessage: boolean;
}

interface CrushToolCallPart {
  id: string | undefined;
  name: string;
  input: string | undefined;
  providerExecuted: boolean | undefined;
  finished: boolean | undefined;
}

interface CrushToolResultPart {
  toolCallId: string | undefined;
  name: string | undefined;
  content: string | undefined;
  data: string | undefined;
  mimeType: string | undefined;
  metadata: string | undefined;
  isError: boolean | undefined;
}

interface ParsedCrushParts {
  text: string;
  reasoning: string[];
  toolCalls: CrushToolCallPart[];
  toolResults: CrushToolResultPart[];
  malformed: boolean;
}

interface ParsedCrushMessage {
  row: CrushMessageRow;
  role: ConversationMessage['role'] | 'tool';
  parts: ParsedCrushParts;
}

interface CrushParseWarnings {
  malformedParts: number;
  unsupportedRoles: number;
}

interface CrushSessionMetadata {
  promptTokens: number;
  completionTokens: number;
  cost: number | undefined;
  todos: string | undefined;
}

function getDatabaseSyncConstructor(): DatabaseSyncConstructor | undefined {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
    return sqlite.DatabaseSync;
  } catch (err) {
    logger.debug('crush: node:sqlite is unavailable', err);
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    const code = nodeErrorCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger.debug('crush: path is not readable', filePath, err);
    }
    return false;
  }
}

async function openReadOnlyDatabase(dbPath: string): Promise<SqliteDatabase | undefined> {
  if (!(await pathExists(dbPath))) return undefined;

  const DatabaseSync = getDatabaseSyncConstructor();
  if (!DatabaseSync) return undefined;

  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    logger.debug('crush: failed to open SQLite database read-only', dbPath, err);
    return undefined;
  }
}

function closeDatabase(db: SqliteDatabase, dbPath: string): void {
  try {
    db.close();
  } catch (err) {
    logger.debug('crush: failed to close SQLite database', dbPath, err);
  }
}

function expandHome(value: string): string {
  if (value === '~') return homeDir();
  if (value.startsWith('~/')) return path.join(homeDir(), value.slice(2));
  return value;
}

function inferCwdFromDbPath(dbPath: string): string {
  const dataDir = path.dirname(dbPath);
  if (path.basename(dataDir) === CRUSH_DATA_DIR) {
    return path.dirname(dataDir);
  }
  return '';
}

function addCandidate(
  candidates: CrushDbCandidate[],
  seen: Set<string>,
  dbPath: string | undefined,
  cwd?: string,
): void {
  if (!dbPath) return;
  const resolvedDbPath = path.resolve(expandHome(dbPath));
  if (seen.has(resolvedDbPath)) return;
  seen.add(resolvedDbPath);

  const resolvedCwd = cwd ? path.resolve(expandHome(cwd)) : inferCwdFromDbPath(resolvedDbPath);
  candidates.push({ dbPath: resolvedDbPath, cwd: resolvedCwd });
}

async function addCwdCandidates(
  candidates: CrushDbCandidate[],
  seen: Set<string>,
  cwd: string | undefined,
): Promise<void> {
  if (!cwd) return;

  let current = path.resolve(expandHome(cwd));
  while (true) {
    const dbPath = path.join(current, CRUSH_DATA_DIR, CRUSH_DB_FILE);
    addCandidate(candidates, seen, dbPath, current);
    if (await pathExists(dbPath)) return;

    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function crushGlobalDataPath(): string {
  if (process.env.CRUSH_GLOBAL_DATA) {
    return path.join(expandHome(process.env.CRUSH_GLOBAL_DATA), 'crush.json');
  }

  if (process.env.XDG_DATA_HOME) {
    return path.join(expandHome(process.env.XDG_DATA_HOME), 'crush', 'crush.json');
  }

  return path.join(homeDir(), '.local', 'share', 'crush', 'crush.json');
}

async function addProjectIndexCandidates(candidates: CrushDbCandidate[], seen: Set<string>): Promise<void> {
  const projectsPath = path.join(path.dirname(crushGlobalDataPath()), 'projects.json');

  try {
    const raw = await fs.readFile(projectsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.projects)) return;

    for (const project of parsed.projects) {
      if (!isRecord(project)) continue;
      const projectPath = stringValue(project, 'path');
      const dataDir = stringValue(project, 'data_dir');
      if (!dataDir) continue;
      addCandidate(candidates, seen, path.join(dataDir, CRUSH_DB_FILE), projectPath);
    }
  } catch (err) {
    const code = nodeErrorCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger.debug('crush: failed to inspect projects index', projectsPath, err);
    }
  }
}

async function getCrushDbCandidates(options?: SessionParseOptions): Promise<CrushDbCandidate[]> {
  const candidates: CrushDbCandidate[] = [];
  const seen = new Set<string>();
  const explicitDb = process.env.CRUSH_DB || process.env.CRUSH_DB_PATH;

  if (explicitDb) {
    addCandidate(candidates, seen, explicitDb);
    return candidates;
  }

  if (process.env.CRUSH_DATA_DIR) {
    addCandidate(candidates, seen, path.join(process.env.CRUSH_DATA_DIR, CRUSH_DB_FILE));
  }

  await addProjectIndexCandidates(candidates, seen);
  await addCwdCandidates(candidates, seen, options?.cwd);
  if (options?.cwd !== process.cwd()) {
    await addCwdCandidates(candidates, seen, process.cwd());
  }
  addCandidate(candidates, seen, path.join(homeDir(), CRUSH_DATA_DIR, CRUSH_DB_FILE));

  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeErrorCode(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  const code = err.code;
  return typeof code === 'string' ? code : undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function jsonStringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.debug('crush: failed to stringify JSON-like value', key, err);
    return undefined;
  }
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (typeof value === 'string') {
    if (value === '1' || value.toLowerCase() === 'true') return true;
    if (value === '0' || value.toLowerCase() === 'false') return false;
  }
  return undefined;
}

function safeAll(db: SqliteDatabase, sql: string, params: unknown[], label: string): unknown[] {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    logger.debug(`crush: failed to query ${label}`, err);
    return [];
  }
}

function safeGet(db: SqliteDatabase, sql: string, params: unknown[], label: string): unknown | undefined {
  try {
    return db.prepare(sql).get(...params);
  } catch (err) {
    logger.debug(`crush: failed to query ${label}`, err);
    return undefined;
  }
}

function columnNames(db: SqliteDatabase, tableName: 'sessions' | 'messages'): Set<string> {
  const rows = safeAll(db, `PRAGMA table_info(${tableName})`, [], `${tableName} columns`);
  const names = new Set<string>();

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = stringValue(row, 'name');
    if (name) names.add(name);
  }

  return names;
}

function getSchema(db: SqliteDatabase): CrushSchema | undefined {
  const sessionColumns = columnNames(db, 'sessions');
  const messageColumns = columnNames(db, 'messages');

  if (!sessionColumns.has('id') || !messageColumns.has('session_id')) {
    return undefined;
  }

  return { sessionColumns, messageColumns };
}

function selectColumn(columns: ReadonlySet<string>, column: string, fallback: string, alias: string): string {
  return columns.has(column) ? `${column} AS ${alias}` : `${fallback} AS ${alias}`;
}

function selectQualifiedColumn(
  columns: ReadonlySet<string>,
  qualifier: string,
  column: string,
  fallback: string,
  alias: string,
): string {
  return columns.has(column) ? `${qualifier}.${column} AS ${alias}` : `${fallback} AS ${alias}`;
}

function messageOrderBy(schema: CrushSchema, direction: 'ASC' | 'DESC' = 'ASC'): string {
  const parts: string[] = [];
  if (schema.messageColumns.has('created_at')) parts.push(`created_at ${direction}`);
  parts.push(schema.messageColumns.has('id') ? `id ${direction}` : `rowid ${direction}`);
  return parts.join(', ');
}

function sessionTimestampExpression(schema: CrushSchema, column: 'created_at' | 'updated_at'): string {
  return schema.sessionColumns.has(column) ? `s.${column}` : 'NULL';
}

function matchesCrushCwd(candidateCwd: string, targetCwd: string): boolean {
  return matchesCwd(candidateCwd, targetCwd) || matchesCwd(targetCwd, candidateCwd);
}

function normalizeTimestamp(value: number | undefined): Date | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;

  // Current Crush SQL writes strftime('%s') and Go code uses time.Now().Unix().
  // Older comments mention milliseconds, so keep accepting both units.
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseSessionRow(row: unknown): CrushSessionRow | undefined {
  if (!isRecord(row)) return undefined;
  const id = stringValue(row, 'id');
  if (!id) return undefined;

  return {
    id,
    title: stringValue(row, 'title') ?? '',
    promptTokens: numberValue(row, 'promptTokens') ?? 0,
    completionTokens: numberValue(row, 'completionTokens') ?? 0,
    cost: numberValue(row, 'cost') ?? 0,
    sessionCreatedAt: numberValue(row, 'sessionCreatedAt'),
    sessionUpdatedAt: numberValue(row, 'sessionUpdatedAt'),
    firstMessageAt: numberValue(row, 'firstMessageAt'),
    lastMessageAt: numberValue(row, 'lastMessageAt'),
    messageCount: numberValue(row, 'messageCount') ?? 0,
    latestModel: stringValue(row, 'latestModel'),
    latestProvider: stringValue(row, 'latestProvider'),
  };
}

function parseMessageRow(row: unknown): CrushMessageRow | undefined {
  if (!isRecord(row)) return undefined;
  const id = stringValue(row, 'id');
  const role = stringValue(row, 'role');
  if (!id || !role) return undefined;

  return {
    id,
    role,
    parts: stringValue(row, 'parts') ?? '[]',
    createdAt: numberValue(row, 'createdAt'),
    model: stringValue(row, 'model'),
    provider: stringValue(row, 'provider'),
    isSummaryMessage: booleanValue(row, 'isSummaryMessage') ?? false,
  };
}

function isGenericTitle(title: string): boolean {
  return GENERIC_TITLES.has(title.trim().toLowerCase());
}

function parseParts(partsJson: string): ParsedCrushParts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(partsJson);
  } catch (err) {
    logger.debug('crush: failed to parse message parts JSON', err);
    return { text: '', reasoning: [], toolCalls: [], toolResults: [], malformed: true };
  }

  if (!Array.isArray(parsed)) {
    return { text: '', reasoning: [], toolCalls: [], toolResults: [], malformed: true };
  }

  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: CrushToolCallPart[] = [];
  const toolResults: CrushToolResultPart[] = [];

  for (const part of parsed) {
    if (!isRecord(part)) continue;
    const type = stringValue(part, 'type');
    const data = isRecord(part.data) ? part.data : {};

    switch (type) {
      case 'text': {
        const value = stringValue(data, 'text') ?? stringValue(part, 'text');
        if (value) text.push(value);
        break;
      }
      case 'reasoning': {
        const thinking = stringValue(data, 'thinking') ?? stringValue(data, 'text') ?? stringValue(part, 'text');
        if (thinking) reasoning.push(thinking);
        break;
      }
      case 'tool_call': {
        const name = stringValue(data, 'name') ?? stringValue(part, 'name') ?? stringValue(part, 'tool');
        if (!name) break;
        toolCalls.push({
          id: stringValue(data, 'id') ?? stringValue(part, 'id') ?? stringValue(data, 'tool_call_id'),
          name,
          input: jsonStringValue(data, 'input') ?? jsonStringValue(part, 'input'),
          providerExecuted: booleanValue(data, 'provider_executed'),
          finished: booleanValue(data, 'finished'),
        });
        break;
      }
      case 'tool_result':
        toolResults.push({
          toolCallId:
            stringValue(data, 'tool_call_id') ??
            stringValue(data, 'toolCallId') ??
            stringValue(part, 'tool_call_id') ??
            stringValue(part, 'toolCallId'),
          name: stringValue(data, 'name') ?? stringValue(part, 'name') ?? stringValue(part, 'tool'),
          content:
            stringValue(data, 'content') ??
            stringValue(data, 'output') ??
            stringValue(data, 'result') ??
            stringValue(part, 'content'),
          data: stringValue(data, 'data'),
          mimeType: stringValue(data, 'mime_type'),
          metadata: stringValue(data, 'metadata'),
          isError: booleanValue(data, 'is_error'),
        });
        break;
      default:
        break;
    }
  }

  return {
    text: text.join('\n').trim(),
    reasoning,
    toolCalls,
    toolResults,
    malformed: false,
  };
}

function normalizeRole(role: string): ConversationMessage['role'] | 'tool' | undefined {
  switch (role) {
    case 'user':
    case 'assistant':
    case 'system':
      return role;
    case 'tool':
      return 'tool';
    default:
      return undefined;
  }
}

function getFirstUserMessage(db: SqliteDatabase, schema: CrushSchema, sessionId: string): string {
  if (!schema.messageColumns.has('role') || !schema.messageColumns.has('parts')) return '';

  const summaryFilter = schema.messageColumns.has('is_summary_message')
    ? 'AND COALESCE(is_summary_message, 0) = 0'
    : '';
  const row = safeGet(
    db,
    `SELECT parts FROM messages WHERE session_id = ? AND role = 'user' ${summaryFilter} ORDER BY ${messageOrderBy(
      schema,
    )} LIMIT 1`,
    [sessionId],
    'first Crush user message',
  );
  if (!isRecord(row)) return '';

  const partsJson = stringValue(row, 'parts');
  if (!partsJson) return '';

  const parts = parseParts(partsJson);
  return parts.malformed ? '' : parts.text;
}

/**
 * Build a correlated subquery expression that returns the requested column
 * (e.g. `model` or `provider`) from the latest non-summary assistant message
 * for the outer `s.id` session. Folding this into the main listing query
 * avoids per-session N+1 queries during `parseCrushSessions`.
 */
function buildLatestAssistantSubquery(schema: CrushSchema, column: 'model' | 'provider'): string {
  if (!schema.messageColumns.has('role') || !schema.messageColumns.has('model')) {
    return 'NULL';
  }
  if (column === 'provider' && !schema.messageColumns.has('provider')) {
    return 'NULL';
  }

  const summaryFilter = schema.messageColumns.has('is_summary_message')
    ? 'AND COALESCE(lm.is_summary_message, 0) = 0'
    : '';
  const orderParts: string[] = [];
  if (schema.messageColumns.has('created_at')) orderParts.push('lm.created_at DESC');
  orderParts.push(schema.messageColumns.has('id') ? 'lm.id DESC' : 'lm.rowid DESC');

  return `(
    SELECT lm.${column}
    FROM messages lm
    WHERE lm.session_id = s.id
      AND lm.role = 'assistant'
      AND lm.model IS NOT NULL
      AND lm.model != ''
      ${summaryFilter}
    ORDER BY ${orderParts.join(', ')}
    LIMIT 1
  )`;
}

function listSessionsFromDb(
  db: SqliteDatabase,
  candidate: CrushDbCandidate,
  options?: SessionParseOptions,
): UnifiedSession[] {
  const schema = getSchema(db);
  if (!schema) return [];

  const messageSummaryJoin = schema.messageColumns.has('is_summary_message')
    ? 'AND COALESCE(m.is_summary_message, 0) = 0'
    : '';
  const parentFilter = schema.sessionColumns.has('parent_session_id') ? 'WHERE s.parent_session_id IS NULL' : '';
  const firstMessageAt = schema.messageColumns.has('created_at') ? 'MIN(m.created_at)' : 'NULL';
  const lastMessageAt = schema.messageColumns.has('created_at') ? 'MAX(m.created_at)' : 'NULL';
  const messageCount = schema.messageColumns.has('id') ? 'COUNT(m.id)' : 'COUNT(m.session_id)';
  const sessionUpdatedAt = sessionTimestampExpression(schema, 'updated_at');
  const sessionCreatedAt = sessionTimestampExpression(schema, 'created_at');
  const orderMessageAt = schema.messageColumns.has('created_at') ? 'MAX(m.created_at)' : 'NULL';
  const orderBy = `COALESCE(${orderMessageAt}, ${sessionUpdatedAt}, ${sessionCreatedAt}, 0)`;
  const latestModelExpression = buildLatestAssistantSubquery(schema, 'model');
  const latestProviderExpression = buildLatestAssistantSubquery(schema, 'provider');
  const rows = safeAll(
    db,
    `SELECT
       s.id AS id,
       ${selectQualifiedColumn(schema.sessionColumns, 's', 'title', "''", 'title')},
       ${selectQualifiedColumn(schema.sessionColumns, 's', 'prompt_tokens', '0', 'promptTokens')},
       ${selectQualifiedColumn(schema.sessionColumns, 's', 'completion_tokens', '0', 'completionTokens')},
       ${selectQualifiedColumn(schema.sessionColumns, 's', 'cost', '0', 'cost')},
       ${selectQualifiedColumn(schema.sessionColumns, 's', 'created_at', 'NULL', 'sessionCreatedAt')},
       ${selectQualifiedColumn(schema.sessionColumns, 's', 'updated_at', 'NULL', 'sessionUpdatedAt')},
       ${firstMessageAt} AS firstMessageAt,
       ${lastMessageAt} AS lastMessageAt,
       ${messageCount} AS messageCount,
       ${latestModelExpression} AS latestModel,
       ${latestProviderExpression} AS latestProvider
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id ${messageSummaryJoin}
     ${parentFilter}
     GROUP BY s.id
     ORDER BY ${orderBy} DESC`,
    [],
    'Crush sessions',
  );

  const sessions: UnifiedSession[] = [];

  for (const rawRow of rows) {
    const row = parseSessionRow(rawRow);
    if (!row || row.messageCount <= 0) continue;

    // Avoid N+1 queries: only read the first user message when the title is
    // empty or matches the generic-title set; otherwise the title alone is the
    // summary source.
    const hasTitle = row.title.trim().length > 0;
    const genericTitle = isGenericTitle(row.title);
    const firstUserMessage = !hasTitle || genericTitle ? getFirstUserMessage(db, schema, row.id) : '';
    const summarySource = genericTitle ? firstUserMessage || row.title : row.title || firstUserMessage;
    const summary = cleanSummary(summarySource);
    if (!summary) continue;

    const createdAt =
      normalizeTimestamp(row.firstMessageAt) ??
      normalizeTimestamp(row.sessionCreatedAt) ??
      normalizeTimestamp(row.sessionUpdatedAt) ??
      new Date(0);
    const updatedAt =
      normalizeTimestamp(row.lastMessageAt) ??
      normalizeTimestamp(row.sessionUpdatedAt) ??
      normalizeTimestamp(row.sessionCreatedAt) ??
      createdAt;
    const cwd = candidate.cwd;

    if (options?.cwd && cwd && !matchesCrushCwd(cwd, options.cwd)) continue;

    sessions.push({
      id: row.id,
      source: CRUSH_SOURCE,
      cwd,
      ...(cwd ? { repo: extractRepoFromCwd(cwd) } : {}),
      lines: row.messageCount,
      bytes: 0,
      createdAt,
      updatedAt,
      originalPath: candidate.dbPath,
      summary,
      ...(row.latestModel ? { model: row.latestModel } : {}),
    });
  }

  return sessions;
}

function sessionDbCandidate(session: UnifiedSession): CrushDbCandidate | undefined {
  if (!session.originalPath || path.basename(session.originalPath) !== CRUSH_DB_FILE) return undefined;
  return {
    dbPath: session.originalPath,
    cwd: session.cwd || inferCwdFromDbPath(session.originalPath),
  };
}

async function findDbForSession(session: UnifiedSession): Promise<CrushDbCandidate | undefined> {
  const direct = sessionDbCandidate(session);
  if (direct && (await pathExists(direct.dbPath))) return direct;

  const candidates = await getCrushDbCandidates(session.cwd ? { cwd: session.cwd } : undefined);
  for (const candidate of candidates) {
    if (!(await pathExists(candidate.dbPath))) continue;
    const db = await openReadOnlyDatabase(candidate.dbPath);
    if (!db) continue;
    try {
      const schema = getSchema(db);
      if (!schema) continue;
      const row = safeGet(db, 'SELECT id FROM sessions WHERE id = ? LIMIT 1', [session.id], 'Crush session lookup');
      if (isRecord(row) && stringValue(row, 'id') === session.id) return candidate;
    } finally {
      closeDatabase(db, candidate.dbPath);
    }
  }

  return undefined;
}

function listMessageRows(db: SqliteDatabase, schema: CrushSchema, sessionId: string): CrushMessageRow[] {
  const idSelect = selectColumn(schema.messageColumns, 'id', 'CAST(rowid AS TEXT)', 'id');
  const roleSelect = selectColumn(schema.messageColumns, 'role', "''", 'role');
  const partsSelect = selectColumn(schema.messageColumns, 'parts', "'[]'", 'parts');
  const modelSelect = selectColumn(schema.messageColumns, 'model', 'NULL', 'model');
  const createdAtSelect = selectColumn(schema.messageColumns, 'created_at', 'NULL', 'createdAt');
  const providerSelect = selectColumn(schema.messageColumns, 'provider', 'NULL', 'provider');
  const summarySelect = selectColumn(schema.messageColumns, 'is_summary_message', '0', 'isSummaryMessage');
  const rows = safeAll(
    db,
    `SELECT
       ${idSelect},
       ${roleSelect},
       ${partsSelect},
       ${createdAtSelect},
       ${modelSelect},
       ${providerSelect},
       ${summarySelect}
     FROM messages
     WHERE session_id = ?
     ORDER BY ${messageOrderBy(schema)}`,
    [sessionId],
    'Crush messages',
  );

  return rows.map(parseMessageRow).filter((row): row is CrushMessageRow => Boolean(row));
}

function getSessionMetadata(db: SqliteDatabase, schema: CrushSchema, sessionId: string): CrushSessionMetadata {
  const row = safeGet(
    db,
    `SELECT
       ${selectColumn(schema.sessionColumns, 'prompt_tokens', '0', 'promptTokens')},
       ${selectColumn(schema.sessionColumns, 'completion_tokens', '0', 'completionTokens')},
       ${selectColumn(schema.sessionColumns, 'cost', 'NULL', 'cost')},
       ${selectColumn(schema.sessionColumns, 'todos', 'NULL', 'todos')}
     FROM sessions
     WHERE id = ?
     LIMIT 1`,
    [sessionId],
    'Crush session metadata',
  );

  if (!isRecord(row)) {
    return { promptTokens: 0, completionTokens: 0, cost: undefined, todos: undefined };
  }

  return {
    promptTokens: numberValue(row, 'promptTokens') ?? 0,
    completionTokens: numberValue(row, 'completionTokens') ?? 0,
    cost: numberValue(row, 'cost'),
    todos: stringValue(row, 'todos'),
  };
}

function isCompletedTodoStatus(status: string | undefined): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'cancelled';
}

function addPendingTask(
  tasks: string[],
  seen: Set<string>,
  content: string | undefined,
  status: string | undefined,
  priority: string | undefined,
  limit: number,
): void {
  if (tasks.length >= limit || !content || isCompletedTodoStatus(status)) return;

  const trimmed = content.trim();
  if (!trimmed) return;

  const formattedPriority = priority?.trim();
  const task = formattedPriority ? `[${formattedPriority}] ${trimmed}` : trimmed;
  if (seen.has(task)) return;
  seen.add(task);
  tasks.push(task);
}

function extractPendingTasksFromTodoText(raw: string, tasks: string[], seen: Set<string>, limit: number): void {
  for (const line of raw.split(/\r?\n/)) {
    if (tasks.length >= limit) return;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const checkbox = trimmed.match(/^(?:[-*]\s*)?(?:\d+\.\s*)?\[([^\]]*)\]\s+(.+)$/);
    if (checkbox) {
      const status = checkbox[1]?.trim() || 'pending';
      addPendingTask(tasks, seen, checkbox[2], status, undefined, limit);
      continue;
    }

    const labeled = trimmed.match(/^(?:todo|pending|in_progress|open)\s*:\s*(.+)$/i);
    if (labeled) {
      addPendingTask(tasks, seen, labeled[1], 'pending', undefined, limit);
    }
  }
}

// Defensive guard for traversing todo payloads. Crush typically writes shallow
// JSON arrays, but pathologically nested values (e.g. `{todos: {todos: ...}}`)
// could otherwise blow the stack — we cap recursion well above any realistic
// real-world depth.
const MAX_TODO_RECURSION_DEPTH = 32;

function extractPendingTasksFromTodoValue(
  value: unknown,
  tasks: string[],
  seen: Set<string>,
  limit: number,
  depth: number,
): void {
  if (tasks.length >= limit || value === undefined || value === null) return;
  if (depth > MAX_TODO_RECURSION_DEPTH) {
    logger.debug('crush: todos recursion depth exceeded; stopping traversal');
    return;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        extractPendingTasksFromTodoValue(JSON.parse(trimmed) as unknown, tasks, seen, limit, depth + 1);
        return;
      } catch (err) {
        logger.debug('crush: failed to parse todos JSON', err);
      }
    }

    extractPendingTasksFromTodoText(trimmed, tasks, seen, limit);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractPendingTasksFromTodoValue(item, tasks, seen, limit, depth + 1);
      if (tasks.length >= limit) return;
    }
    return;
  }

  if (!isRecord(value)) return;

  if ('todos' in value) {
    extractPendingTasksFromTodoValue(value.todos, tasks, seen, limit, depth + 1);
  }

  const content =
    stringValue(value, 'content') ??
    stringValue(value, 'text') ??
    stringValue(value, 'title') ??
    stringValue(value, 'task');
  const status = stringValue(value, 'status') ?? stringValue(value, 'state');
  const priority = stringValue(value, 'priority');
  addPendingTask(tasks, seen, content, status, priority, limit);
}

function extractPendingTasksFromTodos(todos: string | undefined, limit: number): string[] {
  if (!todos || limit <= 0) return [];

  const tasks: string[] = [];
  extractPendingTasksFromTodoValue(todos, tasks, new Set<string>(), limit, 0);
  return tasks;
}

function parseToolInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};

  try {
    const parsed: unknown = JSON.parse(input);
    if (isRecord(parsed)) return parsed;
    return { input: parsed };
  } catch (err) {
    logger.debug('crush: failed to parse tool input JSON', err);
    return { input };
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(record, key);
    if (value) return value;
  }
  return '';
}

function classifyCrushToolName(name: string): ToolSampleCategory | undefined {
  switch (name.toLowerCase()) {
    case 'bash':
    case 'shell':
      return 'shell';
    case 'write':
      return 'write';
    case 'view':
    case 'read':
      return 'read';
    case 'edit':
    case 'multiedit':
      return 'edit';
    case 'ls':
      return 'glob';
    case 'fetch':
    case 'agentic_fetch':
    case 'download':
      return 'fetch';
    case 'sourcegraph':
      return 'search';
    default:
      return classifyToolName(name);
  }
}

function toolResultPreview(result: CrushToolResultPart | undefined): string | undefined {
  if (!result) return undefined;
  if (result.content) return truncate(result.content, 500);
  if (result.data) return result.mimeType ? `[${result.mimeType} data]` : '[binary data]';
  if (result.metadata) return truncate(result.metadata, 500);
  return undefined;
}

function crushToolCallToUnified(call: CrushToolCallPart, result: CrushToolResultPart | undefined): ToolCall {
  const metadata: Record<string, unknown> = {};
  if (call.providerExecuted !== undefined) metadata.providerExecuted = call.providerExecuted;
  if (call.finished !== undefined) metadata.finished = call.finished;

  const output: ToolCall = {
    name: call.name,
    ...(call.id ? { id: call.id } : {}),
    ...(call.input ? { arguments: parseToolInput(call.input) } : {}),
    ...(toolResultPreview(result) ? { result: toolResultPreview(result) } : {}),
    ...(result?.isError !== undefined ? { success: !result.isError } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  return output;
}

function addToolSummary(
  collector: SummaryCollector,
  call: CrushToolCallPart,
  result: CrushToolResultPart | undefined,
): void {
  const category = classifyCrushToolName(call.name);
  if (!category) return;

  const args = parseToolInput(call.input);
  const resultText = toolResultPreview(result);
  const filePath = firstString(args, ['file_path', 'filePath', 'path', 'filename']);
  const shouldTrackFileMutation = Boolean(filePath) && result?.isError !== true;

  switch (category) {
    case 'shell': {
      const command = firstString(args, ['command', 'cmd', 'input']);
      collector.add(call.name, shellSummary(command, resultText), {
        data: { category: 'shell', command, ...(result?.isError ? { errored: true } : {}) },
        isError: result?.isError,
      });
      break;
    }
    case 'read':
      collector.add(call.name, fileSummary('read', filePath || '(unknown file)'), {
        data: { category: 'read', filePath: filePath || '(unknown file)' },
        filePath,
      });
      break;
    case 'write':
      collector.add(call.name, fileSummary('write', filePath || '(unknown file)', undefined, false), {
        data: { category: 'write', filePath: filePath || '(unknown file)' },
        filePath,
        isWrite: shouldTrackFileMutation,
        isError: result?.isError,
      });
      break;
    case 'edit':
      collector.add(call.name, fileSummary('edit', filePath || '(unknown file)'), {
        data: { category: 'edit', filePath: filePath || '(unknown file)' },
        filePath,
        isWrite: shouldTrackFileMutation,
        isError: result?.isError,
      });
      break;
    case 'grep': {
      const pattern = firstString(args, ['pattern', 'query', 'input']);
      collector.add(call.name, grepSummary(pattern, filePath || undefined), {
        data: { category: 'grep', pattern, ...(filePath ? { targetPath: filePath } : {}) },
        isError: result?.isError,
      });
      break;
    }
    case 'glob': {
      const pattern = firstString(args, ['pattern', 'path', 'input']);
      collector.add(call.name, globSummary(pattern), {
        data: { category: 'glob', pattern },
        isError: result?.isError,
      });
      break;
    }
    case 'search': {
      const query = firstString(args, ['query', 'input']);
      collector.add(call.name, searchSummary(query), {
        data: { category: 'search', query },
        isError: result?.isError,
      });
      break;
    }
    case 'fetch': {
      const url = firstString(args, ['url', 'input']);
      collector.add(call.name, fetchSummary(url), {
        data: { category: 'fetch', url },
        isError: result?.isError,
      });
      break;
    }
    case 'task': {
      const description = firstString(args, ['description', 'prompt', 'input']);
      collector.add(call.name, `task "${truncate(description, 60)}"`, {
        data: { category: 'task', description },
        isError: result?.isError,
      });
      break;
    }
    case 'ask': {
      const question = truncate(firstString(args, ['question', 'prompt', 'input']), 80);
      collector.add(call.name, `ask: "${question}"`, {
        data: { category: 'ask', question },
        isError: result?.isError,
      });
      break;
    }
    default: {
      const argsPreview = Object.keys(args).length > 0 ? truncate(JSON.stringify(args), 120) : '';
      collector.add(call.name, mcpSummary(call.name, argsPreview, resultText), {
        data: { category: 'mcp', toolName: call.name, ...(argsPreview ? { params: argsPreview } : {}) },
        isError: result?.isError,
      });
      break;
    }
  }
}

function buildParsedMessages(rows: CrushMessageRow[]): {
  messages: ParsedCrushMessage[];
  warnings: CrushParseWarnings;
  resultsByCallId: Map<string, CrushToolResultPart>;
} {
  const messages: ParsedCrushMessage[] = [];
  const warnings: CrushParseWarnings = { malformedParts: 0, unsupportedRoles: 0 };
  const resultsByCallId = new Map<string, CrushToolResultPart>();

  for (const row of rows) {
    if (row.isSummaryMessage) continue;

    const parts = parseParts(row.parts);
    if (parts.malformed) {
      warnings.malformedParts++;
      continue;
    }

    const role = normalizeRole(row.role);
    if (!role) {
      warnings.unsupportedRoles++;
      continue;
    }

    const parsed: ParsedCrushMessage = { row, role, parts };
    messages.push(parsed);

    for (const result of parts.toolResults) {
      if (result.toolCallId) {
        resultsByCallId.set(result.toolCallId, result);
      }
    }
  }

  return { messages, warnings, resultsByCallId };
}

function buildConversationAndTools(
  parsedMessages: ParsedCrushMessage[],
  resultsByCallId: Map<string, CrushToolResultPart>,
  config: VerbosityConfig,
): {
  messages: ConversationMessage[];
  summaries: ToolUsageSummary[];
  filesModified: string[];
  model: string | undefined;
  provider: string | undefined;
  reasoning: string[];
} {
  const collector = new SummaryCollector(config);
  const messages: ConversationMessage[] = [];
  const reasoning: string[] = [];
  let model: string | undefined;
  let provider: string | undefined;

  for (const parsed of parsedMessages) {
    const { row, role, parts } = parsed;
    if (!model && row.model) model = row.model;
    if (!provider && row.provider) provider = row.provider;

    for (const thought of parts.reasoning) {
      if (reasoning.length < 5) reasoning.push(truncate(thought, 240));
    }

    for (const call of parts.toolCalls) {
      const result = call.id ? resultsByCallId.get(call.id) : undefined;
      addToolSummary(collector, call, result);
    }

    if (role === 'tool') continue;

    const toolCalls = parts.toolCalls.map((call) =>
      crushToolCallToUnified(call, call.id ? resultsByCallId.get(call.id) : undefined),
    );
    const toolCallText = toolCalls.length > 0 ? toolCalls.map((call) => `[tool_call:${call.name}]`).join('\n') : '';
    const content = [parts.text, toolCallText].filter(Boolean).join('\n').trim();
    if (!content && toolCalls.length === 0) continue;

    messages.push({
      role,
      content,
      ...(normalizeTimestamp(row.createdAt) ? { timestamp: normalizeTimestamp(row.createdAt) } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      sourceId: row.id,
    });
  }

  return {
    messages,
    summaries: collector.getSummaries(),
    filesModified: collector.getFilesModified(),
    model,
    provider,
    reasoning,
  };
}

function buildSessionNotes(params: {
  model: string | undefined;
  provider: string | undefined;
  metadata: CrushSessionMetadata;
  dbPath: string;
  reasoning: string[];
  warnings: CrushParseWarnings;
}): SessionNotes | undefined {
  const notes: SessionNotes = {};
  const sourceMetadata: Record<string, unknown> = {};

  if (params.model) notes.model = params.model;
  if (params.metadata.promptTokens > 0 || params.metadata.completionTokens > 0) {
    notes.tokenUsage = { input: params.metadata.promptTokens, output: params.metadata.completionTokens };
  }
  if (params.reasoning.length > 0) notes.reasoning = params.reasoning;
  if (params.provider) sourceMetadata.provider = params.provider;
  if (params.metadata.cost !== undefined) sourceMetadata.cost = params.metadata.cost;
  if (Object.keys(sourceMetadata).length > 0) notes.sourceMetadata = sourceMetadata;

  notes.rawAccess = { kind: 'sqlite', path: params.dbPath };

  const fidelityWarnings: string[] = [];
  if (params.warnings.malformedParts > 0) {
    fidelityWarnings.push(
      `Skipped ${params.warnings.malformedParts} Crush message${params.warnings.malformedParts === 1 ? '' : 's'} with malformed parts JSON.`,
    );
  }
  if (params.warnings.unsupportedRoles > 0) {
    fidelityWarnings.push(
      `Skipped ${params.warnings.unsupportedRoles} Crush message${params.warnings.unsupportedRoles === 1 ? '' : 's'} with unsupported role.`,
    );
  }
  if (fidelityWarnings.length > 0) notes.fidelityWarnings = fidelityWarnings;

  return Object.keys(notes).length > 0 ? notes : undefined;
}

function emptyContext(
  session: UnifiedSession,
  config: VerbosityConfig,
  warning: string | undefined,
  dbPath: string | undefined,
): SessionContext {
  const sessionNotes: SessionNotes | undefined =
    warning || dbPath
      ? {
          ...(warning ? { fidelityWarnings: [warning] } : {}),
          ...(dbPath ? { rawAccess: { kind: 'sqlite', path: dbPath } } : {}),
        }
      : undefined;
  const markdown = generateHandoffMarkdown(session, [], [], [], [], sessionNotes, config);

  return {
    session,
    recentMessages: [],
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    sessionNotes,
    markdown,
  };
}

/**
 * Parse all Crush sessions from read-only SQLite databases.
 */
export async function parseCrushSessions(options?: SessionParseOptions): Promise<UnifiedSession[]> {
  const candidates = await getCrushDbCandidates(options);
  const sessions: UnifiedSession[] = [];

  for (const candidate of candidates) {
    const db = await openReadOnlyDatabase(candidate.dbPath);
    if (!db) continue;

    try {
      sessions.push(...listSessionsFromDb(db, candidate, options));
    } finally {
      closeDatabase(db, candidate.dbPath);
    }
  }

  sessions.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  return options?.limit ? sessions.slice(0, options.limit) : sessions;
}

/**
 * Extract context from a Crush session for cross-tool continuation.
 */
export async function extractCrushContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const candidate = await findDbForSession(session);
  if (!candidate) {
    return emptyContext(session, resolvedConfig, 'Crush SQLite database was not found or was unreadable.', undefined);
  }

  const db = await openReadOnlyDatabase(candidate.dbPath);
  if (!db) {
    return emptyContext(
      session,
      resolvedConfig,
      'Crush SQLite database was not found or was unreadable.',
      candidate.dbPath,
    );
  }

  try {
    const schema = getSchema(db);
    if (!schema) {
      return emptyContext(
        session,
        resolvedConfig,
        'Crush SQLite schema was missing required sessions/messages tables or columns.',
        candidate.dbPath,
      );
    }

    const rows = listMessageRows(db, schema, session.id);
    const metadata = getSessionMetadata(db, schema, session.id);
    const parsed = buildParsedMessages(rows);
    const extracted = buildConversationAndTools(parsed.messages, parsed.resultsByCallId, resolvedConfig);
    const pendingTasks = extractPendingTasksFromTodos(metadata.todos, resolvedConfig.pendingTasks.maxTasks);
    const sessionNotes = buildSessionNotes({
      model: extracted.model ?? session.model,
      provider: extracted.provider,
      metadata,
      dbPath: candidate.dbPath,
      reasoning: extracted.reasoning,
      warnings: parsed.warnings,
    });
    const recentMessages = extracted.messages.slice(-resolvedConfig.recentMessages);
    const enrichedSession: UnifiedSession = {
      ...session,
      cwd: session.cwd || candidate.cwd,
      ...(extracted.model || session.model ? { model: extracted.model ?? session.model } : {}),
    };

    const markdown = generateHandoffMarkdown(
      enrichedSession,
      recentMessages,
      extracted.filesModified,
      pendingTasks,
      extracted.summaries,
      sessionNotes,
      resolvedConfig,
    );

    return {
      session: enrichedSession,
      recentMessages,
      filesModified: extracted.filesModified,
      pendingTasks,
      toolSummaries: extracted.summaries,
      sessionNotes,
      markdown,
    };
  } finally {
    closeDatabase(db, candidate.dbPath);
  }
}

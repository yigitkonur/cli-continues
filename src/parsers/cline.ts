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
  ToolCall,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import {
  fileSummary,
  globSummary,
  grepSummary,
  mcpSummary,
  SummaryCollector,
  shellSummary,
  truncate,
  withResult,
} from '../utils/tool-summarizer.js';

const require = createRequire(import.meta.url);

// ── Extension Configs ───────────────────────────────────────────────────────

/**
 * All Cline-family extensions share the same ui_messages.json format.
 * Each entry maps a VS Code extension ID to the source label used in UnifiedSession.
 */
const CLINE_EXTENSIONS = [
  {
    id: 'saoudrizwan.claude-dev',
    source: 'cline',
    customStorageSettingKeys: ['cline.customStoragePath'],
    customStorageEnvKeys: ['CLINE_STORAGE_PATH', 'CONTINUES_CLINE_STORAGE_PATH'],
  },
  {
    id: 'rooveterinaryinc.roo-cline',
    source: 'roo-code',
    customStorageSettingKeys: ['roo-cline.customStoragePath'],
    customStorageEnvKeys: ['ROO_CODE_STORAGE_PATH', 'ROO_CLINE_STORAGE_PATH', 'CONTINUES_ROO_CODE_STORAGE_PATH'],
  },
  {
    id: 'roo-code.roo-cline',
    source: 'roo-code',
    customStorageSettingKeys: [],
    customStorageEnvKeys: [],
  },
  {
    id: 'kilocode.kilo-code',
    source: 'kilo-code',
    customStorageSettingKeys: ['kilo-code.customStoragePath'],
    customStorageEnvKeys: ['KILO_CODE_STORAGE_PATH', 'CONTINUES_KILO_CODE_STORAGE_PATH'],
  },
] as const;

type ClineSource = (typeof CLINE_EXTENSIONS)[number]['source'];
type ClineExtension = (typeof CLINE_EXTENSIONS)[number];

const UI_MESSAGES_FILE = 'ui_messages.json';
const API_CONVERSATION_HISTORY_FILE = 'api_conversation_history.json';
const TASK_METADATA_FILE = 'task_metadata.json';
const TASK_HISTORY_FILE = 'taskHistory.json';
const HISTORY_ITEM_FILE = 'history_item.json';
const HISTORY_INDEX_FILE = '_index.json';
const TASK_SIGNAL_FILES = [
  UI_MESSAGES_FILE,
  API_CONVERSATION_HISTORY_FILE,
  TASK_METADATA_FILE,
  HISTORY_ITEM_FILE,
] as const;

// ── Raw Message Shape ───────────────────────────────────────────────────────

/** Single entry in ui_messages.json */
interface ClineRawMessage {
  ts?: number;
  type: string;
  say?: string;
  ask?: string;
  text?: string;
  reasoning?: string;
  images?: string[];
  files?: string[];
  partial?: boolean;
  modelInfo?: ClineModelInfo;
}

type ConversationRole = 'user' | 'assistant';

interface ConversationState {
  hasSeenApiRequest: boolean;
}

interface StreamState {
  index: number;
  role: ConversationRole;
  kind: string;
}

interface ClineModelInfo {
  modelId?: string;
  providerId?: string;
  mode?: string;
}

interface ClineApiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClineApiMessage {
  id?: string;
  role: ConversationRole;
  content: string | ClineApiContentBlock[];
  ts?: number;
  modelInfo?: ClineModelInfo;
  metrics?: Record<string, unknown>;
}

interface ClineTaskMetadata {
  model_usage?: Array<Record<string, unknown>>;
  files_in_context?: Array<Record<string, unknown>>;
  environment_history?: Array<Record<string, unknown>>;
}

interface ClineTaskHistoryItem {
  id: string;
  ts?: number;
  task?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheWrites?: number;
  cacheReads?: number;
  cwdOnTaskInitialization?: string;
  workspace?: string;
  modelId?: string;
  mode?: string;
  status?: string;
  apiConfigName?: string;
}

interface TaskRoot {
  tasksRoot: string;
  storageRoot: string;
  source: ClineSource;
}

interface TaskEntry {
  taskDir: string;
  taskId: string;
  storageRoot: string;
  source: ClineSource;
}

type TaskHistoryMap = Map<string, ClineTaskHistoryItem>;

interface TaskFiles {
  taskDir: string;
  storageRoot: string;
  uiMessages: string;
  apiConversationHistory: string;
  taskMetadata: string;
  historyItem: string;
  taskHistoryCandidates: string[];
}

interface LoadedTaskData {
  files: TaskFiles;
  uiMessages: ClineRawMessage[];
  apiMessages: ClineApiMessage[];
  taskMetadata?: ClineTaskMetadata;
  taskHistoryItem?: ClineTaskHistoryItem;
  /**
   * Companion-file fidelity warnings. Populated when a companion file exists
   * on disk but cannot be parsed (invalid JSON, wrong shape) so the caller
   * can surface the downgrade in `sessionNotes.fidelityWarnings`. Missing
   * files are NOT warnings — only present-but-broken files are.
   */
  fidelityWarnings: string[];
}

interface ToolResultEntry {
  text: string;
  isError: boolean;
}

interface ToolData {
  summaries: ToolUsageSummary[];
  filesModified: string[];
  fidelityWarnings: string[];
}

interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

interface KiloDbSchema {
  session: Set<string>;
  message: Set<string>;
  part: Set<string>;
  project: Set<string>;
  supported: boolean;
  warnings: string[];
}

interface KiloDbMessageRead {
  messages: ConversationMessage[];
  notes: SessionNotes;
  rowCount: number;
  firstTimestamp?: Date;
  lastTimestamp?: Date;
}

// ── Path Discovery ──────────────────────────────────────────────────────────

/**
 * Build candidate globalStorage base directories for the current platform.
 * Covers VS Code, VS Code Insiders, and Cursor on macOS / Linux / Windows.
 */
function getGlobalStorageBases(): string[] {
  const home = homeDir();
  const bases: string[] = [];

  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    bases.push(
      path.join(appSupport, 'Code', 'User', 'globalStorage'),
      path.join(appSupport, 'Code - Insiders', 'User', 'globalStorage'),
      path.join(appSupport, 'Cursor', 'User', 'globalStorage'),
      path.join(appSupport, 'Windsurf', 'User', 'globalStorage'),
    );
  } else if (process.platform === 'linux') {
    bases.push(
      path.join(home, '.config', 'Code', 'User', 'globalStorage'),
      path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage'),
      path.join(home, '.config', 'Cursor', 'User', 'globalStorage'),
      path.join(home, '.config', 'Windsurf', 'User', 'globalStorage'),
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    bases.push(
      path.join(appData, 'Code', 'User', 'globalStorage'),
      path.join(appData, 'Code - Insiders', 'User', 'globalStorage'),
      path.join(appData, 'Cursor', 'User', 'globalStorage'),
      path.join(appData, 'Windsurf', 'User', 'globalStorage'),
    );
  }

  bases.push(
    path.join(home, '.vscode-server', 'data', 'User', 'globalStorage'),
    path.join(home, '.vscode-server-insiders', 'data', 'User', 'globalStorage'),
    path.join(home, '.cursor-server', 'data', 'User', 'globalStorage'),
    path.join(home, '.cursor-server-insiders', 'data', 'User', 'globalStorage'),
  );

  return uniquePaths(bases);
}

function getJetBrainsRoots(): string[] {
  const home = homeDir();

  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'JetBrains')];
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(appData, 'JetBrains')];
  }

  return [path.join(home, '.config', 'JetBrains')];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const filePath of paths) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    // Push the resolved (canonical, absolute) path so downstream joins,
    // existence checks, and de-dup keys stay reliable when `CLINE_DIR` or
    // other inputs were relative.
    results.push(resolved);
  }
  return results;
}

function settingsPathForGlobalStorage(base: string): string {
  return path.join(path.dirname(base), 'settings.json');
}

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homeDir(), trimmed.slice(2));
  }
  return trimmed;
}

function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inString && char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (!inString && char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    result += char;

    if (escaped) {
      escaped = false;
    } else if (char === '\\' && inString) {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    }
  }

  return result.replace(/,\s*([}\]])/gu, '$1');
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(await fs.readFile(settingsPath, 'utf8')));
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    logger.debug(`cline: cannot read settings ${settingsPath}`, err);
    return {};
  }
}

async function discoverCustomStorageRoots(ext: ClineExtension, globalStorageBases: string[]): Promise<string[]> {
  const roots: string[] = [];
  const addRoot = (value: string): void => {
    const expanded = expandHomePath(value);
    if (path.isAbsolute(expanded)) roots.push(expanded);
  };

  for (const envKey of ext.customStorageEnvKeys) {
    const value = process.env[envKey];
    if (value) addRoot(value);
  }

  for (const base of globalStorageBases) {
    const settings = await readSettings(settingsPathForGlobalStorage(base));
    for (const settingKey of ext.customStorageSettingKeys) {
      const value = readString(settings, settingKey);
      if (value) addRoot(value);
    }
  }

  return uniquePaths(roots);
}

async function findDirsNamed(root: string, dirName: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      logger.debug(`cline: cannot scan ${current}`, err);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.name === dirName) {
        found.push(child);
        continue;
      }
      await walk(child, depth + 1);
    }
  }

  if (await pathExists(root)) await walk(root, 0);
  return found;
}

async function getJetBrainsGlobalStorageBases(): Promise<string[]> {
  const bases: string[] = [];
  for (const root of getJetBrainsRoots()) {
    bases.push(...(await findDirsNamed(root, 'globalStorage', 3)));
  }
  return uniquePaths(bases);
}

function getClineCliStorageRoots(): string[] {
  const roots: string[] = [];
  const clineDir = process.env.CLINE_DIR;
  if (clineDir) roots.push(path.join(clineDir, 'data'));
  roots.push(path.join(homeDir(), '.cline', 'data'));
  return uniquePaths(roots);
}

async function getTaskRoots(filterSource?: ClineSource): Promise<TaskRoot[]> {
  const roots: TaskRoot[] = [];

  if (!filterSource || filterSource === 'cline') {
    for (const storageRoot of getClineCliStorageRoots()) {
      roots.push({
        tasksRoot: path.join(storageRoot, 'tasks'),
        storageRoot,
        source: 'cline',
      });
    }
  }

  const globalStorageBases = uniquePaths([...getGlobalStorageBases(), ...(await getJetBrainsGlobalStorageBases())]);
  for (const base of globalStorageBases) {
    for (const ext of CLINE_EXTENSIONS) {
      if (filterSource && ext.source !== filterSource) continue;
      const storageRoot = path.join(base, ext.id);
      roots.push({
        tasksRoot: path.join(storageRoot, 'tasks'),
        storageRoot,
        source: ext.source,
      });
    }
  }

  for (const ext of CLINE_EXTENSIONS) {
    if (filterSource && ext.source !== filterSource) continue;
    for (const storageRoot of await discoverCustomStorageRoots(ext, globalStorageBases)) {
      roots.push({
        tasksRoot: path.join(storageRoot, 'tasks'),
        storageRoot,
        source: ext.source,
      });
    }
  }

  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = `${root.source}:${path.resolve(root.tasksRoot)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function taskHasReadableData(taskDir: string): Promise<boolean> {
  for (const fileName of TASK_SIGNAL_FILES) {
    if (await pathExists(path.join(taskDir, fileName))) return true;
  }
  return false;
}

/**
 * Discover all task directories for a given extension across all IDE locations.
 * Returns tuples of (task-id directory path, extension source label).
 */
async function discoverTaskDirs(filterSource?: ClineSource): Promise<TaskEntry[]> {
  const taskRoots = await getTaskRoots(filterSource);
  const results: TaskEntry[] = [];

  for (const { tasksRoot, storageRoot, source } of taskRoots) {
    if (!(await pathExists(tasksRoot))) continue;

    try {
      const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskDir = path.join(tasksRoot, entry.name);
        if (await taskHasReadableData(taskDir)) {
          results.push({ taskDir, taskId: entry.name, storageRoot, source });
        }
      }
    } catch (err) {
      logger.debug(`cline: cannot read tasks dir ${tasksRoot}`, err);
    }
  }

  return results;
}

// ── Kilo Code SQLite Discovery ──────────────────────────────────────────────

function cleanEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build the ordered list of candidate Kilo data roots. The default app
 * directory upstream is the literal "kilo" name appended to xdg-basedir's
 * data root (packages/opencode/src/global/index.ts: `const app = "kilo"`),
 * so on every platform Kilo first writes under `$XDG_DATA_HOME/kilo` or
 * `~/.local/share/kilo`. The macOS / Windows fallbacks below are defensive
 * paths for non-default installs (sandboxed environments, custom XDG layouts
 * that mirror native OS conventions). Upstream Kilo does NOT itself write to
 * `~/Library/Application Support/kilo` or `%APPDATA%\kilo`; we probe them
 * only so a non-canonical install does not silently disappear from discovery.
 */
function getKiloDataRoots(): string[] {
  const home = homeDir();
  const roots: string[] = [];
  const xdgDataHome = cleanEnvPath(process.env.XDG_DATA_HOME);

  if (xdgDataHome) roots.push(path.join(xdgDataHome, 'kilo'));

  // Kilo's canonical default on every platform via xdg-basedir fallback.
  roots.push(path.join(home, '.local', 'share', 'kilo'));

  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'kilo'));
  } else if (process.platform === 'win32') {
    const localAppData = cleanEnvPath(process.env.LOCALAPPDATA);
    const appData = cleanEnvPath(process.env.APPDATA);
    if (localAppData) roots.push(path.join(localAppData, 'kilo'));
    if (appData) roots.push(path.join(appData, 'kilo'));
  }

  return uniquePaths(roots);
}

function getKiloDbCandidatePaths(): string[] {
  const kiloDb = cleanEnvPath(process.env.KILO_DB);
  if (kiloDb) {
    if (kiloDb === ':memory:') return [];
    if (path.isAbsolute(kiloDb)) return [kiloDb];
    return uniquePaths(getKiloDataRoots().map((root) => path.join(root, kiloDb)));
  }

  return uniquePaths(getKiloDataRoots().map((root) => path.join(root, 'kilo.db')));
}

async function discoverKiloDbPaths(): Promise<string[]> {
  const dbPaths: string[] = [];
  for (const dbPath of getKiloDbCandidatePaths()) {
    if (await pathExists(dbPath)) dbPaths.push(dbPath);
  }
  return dbPaths;
}

/**
 * Open Kilo's SQLite session store strictly read-only. Read-only is enforced
 * via `node:sqlite`'s `readOnly: true` flag (Node.js v22+; verified at
 * runtime by our integration test, which asserts that any write through this
 * handle throws). Read-only is non-negotiable: this parser must never mutate
 * a user's `kilo.db`.
 */
function openKiloDb(dbPath: string): { db: SqliteDatabase; close: () => void } | null {
  try {
    const sqliteModule = require('node:sqlite') as {
      DatabaseSync: new (database: string, options?: { open?: boolean; readOnly?: boolean }) => SqliteDatabase;
    };
    const db = new sqliteModule.DatabaseSync(dbPath, { open: true, readOnly: true });
    return { db, close: () => db.close() };
  } catch (err) {
    logger.debug('kilo-code: failed to open SQLite database', dbPath, err);
    return null;
  }
}

function tableColumns(db: SqliteDatabase, tableName: 'session' | 'message' | 'part' | 'project'): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const columns = new Set<string>();
    for (const row of rows) {
      if (isRecord(row) && typeof row.name === 'string') columns.add(row.name);
    }
    return columns;
  } catch (err) {
    logger.debug('kilo-code: failed to inspect SQLite table', tableName, err);
    return new Set();
  }
}

function missingColumns(columns: Set<string>, required: readonly string[]): string[] {
  return required.filter((column) => !columns.has(column));
}

function inspectKiloDbSchema(db: SqliteDatabase): KiloDbSchema {
  const schema: KiloDbSchema = {
    session: tableColumns(db, 'session'),
    message: tableColumns(db, 'message'),
    part: tableColumns(db, 'part'),
    project: tableColumns(db, 'project'),
    supported: true,
    warnings: [],
  };

  const required: Array<[keyof Pick<KiloDbSchema, 'session' | 'message' | 'part'>, readonly string[]]> = [
    ['session', ['id']],
    ['message', ['id', 'session_id', 'data']],
    ['part', ['message_id', 'data']],
  ];

  for (const [tableName, requiredColumns] of required) {
    const columns = schema[tableName];
    if (columns.size === 0) {
      schema.warnings.push(`Kilo SQLite schema unsupported: missing "${tableName}" table.`);
      continue;
    }

    const missing = missingColumns(columns, requiredColumns);
    if (missing.length > 0) {
      schema.warnings.push(
        `Kilo SQLite schema unsupported: "${tableName}" table is missing column(s): ${missing.join(', ')}.`,
      );
    }
  }

  schema.supported = schema.warnings.length === 0;
  return schema;
}

function warnKiloDbFidelity(dbPath: string, warnings: string[]): void {
  if (warnings.length === 0) return;
  logger.warn('kilo-code: skipping SQLite database with unsupported schema', dbPath, warnings.join(' '));
}

// ── Message Parsing ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function normalizeModelInfo(value: unknown): ClineModelInfo | undefined {
  if (!isRecord(value)) return undefined;
  const modelId = readString(value, 'modelId') ?? readString(value, 'model_id');
  const providerId = readString(value, 'providerId') ?? readString(value, 'model_provider_id');
  const mode = readString(value, 'mode');
  if (!modelId && !providerId && !mode) return undefined;
  return { modelId, providerId, mode };
}

function normalizeRawMessage(value: unknown): ClineRawMessage | null {
  if (!isRecord(value)) return null;

  const type = readString(value, 'type');
  if (!type) return null;

  return {
    type,
    ts: readNumber(value, 'ts'),
    say: readString(value, 'say'),
    ask: readString(value, 'ask'),
    text: readString(value, 'text'),
    reasoning: readString(value, 'reasoning'),
    images: readStringArray(value, 'images'),
    files: readStringArray(value, 'files'),
    partial: readBoolean(value, 'partial'),
    modelInfo: normalizeModelInfo(value.modelInfo),
  };
}

function normalizeApiContentBlock(value: unknown): ClineApiContentBlock | null {
  if (!isRecord(value)) return null;
  const type = readString(value, 'type');
  if (!type) return null;

  return {
    type,
    text: readString(value, 'text'),
    thinking: readString(value, 'thinking'),
    id: readString(value, 'id'),
    name: readString(value, 'name'),
    input: readRecord(value, 'input'),
    tool_use_id: readString(value, 'tool_use_id'),
    content: value.content,
    is_error: readBoolean(value, 'is_error'),
  };
}

function normalizeApiMessage(value: unknown): ClineApiMessage | null {
  if (!isRecord(value)) return null;
  const rawRole = readString(value, 'role');
  if (rawRole !== 'user' && rawRole !== 'assistant') return null;

  const rawContent = value.content;
  let content: ClineApiMessage['content'] | undefined;
  if (typeof rawContent === 'string') {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    const blocks = rawContent
      .map(normalizeApiContentBlock)
      .filter((block): block is ClineApiContentBlock => block !== null);
    content = blocks;
  }

  if (content === undefined) return null;

  return {
    id: readString(value, 'id'),
    role: rawRole,
    content,
    ts: readNumber(value, 'ts'),
    modelInfo: normalizeModelInfo(value.modelInfo),
    metrics: readRecord(value, 'metrics'),
  };
}

function normalizeTaskMetadata(value: unknown): ClineTaskMetadata | undefined {
  if (!isRecord(value)) return undefined;

  const readRecordArray = (key: string): Array<Record<string, unknown>> | undefined => {
    const raw = value[key];
    if (!Array.isArray(raw)) return undefined;
    const records = raw.filter(isRecord);
    return records.length > 0 ? records : undefined;
  };

  return {
    model_usage: readRecordArray('model_usage'),
    files_in_context: readRecordArray('files_in_context'),
    environment_history: readRecordArray('environment_history'),
  };
}

function normalizeTaskHistoryItem(value: unknown): ClineTaskHistoryItem | null {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  if (!id) return null;

  return {
    id,
    ts: readNumber(value, 'ts'),
    task: readString(value, 'task'),
    tokensIn: readNumber(value, 'tokensIn'),
    tokensOut: readNumber(value, 'tokensOut'),
    cacheWrites: readNumber(value, 'cacheWrites'),
    cacheReads: readNumber(value, 'cacheReads'),
    cwdOnTaskInitialization: readString(value, 'cwdOnTaskInitialization') ?? readString(value, 'workspace'),
    workspace: readString(value, 'workspace'),
    modelId: readString(value, 'modelId'),
    mode: readString(value, 'mode'),
    status: readString(value, 'status'),
    apiConfigName: readString(value, 'apiConfigName'),
  };
}

/**
 * Companion-file read result. `warning` is set when the file existed but
 * could not be parsed or had the wrong shape. Missing files produce no
 * warning. The caller threads warnings into `sessionNotes.fidelityWarnings`.
 */
interface ReadResult<T> {
  value: T;
  warning?: string;
}

async function readJson(filePath: string, label: string): Promise<{ parsed?: unknown; warning?: string }> {
  if (!(await pathExists(filePath))) return {};
  try {
    return { parsed: JSON.parse(await fs.readFile(filePath, 'utf8')) };
  } catch (err) {
    logger.debug(`cline: failed to parse ${label}`, filePath, err);
    return { warning: `${label} could not be parsed (invalid JSON)` };
  }
}

/** Read and parse ui_messages.json. Returns an empty array on failure. */
async function readUiMessages(filePath: string): Promise<ReadResult<ClineRawMessage[]>> {
  const { parsed, warning } = await readJson(filePath, UI_MESSAGES_FILE);
  if (warning) return { value: [], warning };
  if (parsed === undefined) return { value: [] };
  if (!Array.isArray(parsed)) {
    return {
      value: [],
      warning: `${UI_MESSAGES_FILE} had unexpected shape (expected JSON array)`,
    };
  }
  return {
    value: parsed.map(normalizeRawMessage).filter((msg): msg is ClineRawMessage => msg !== null),
  };
}

async function readApiConversationHistory(filePath: string): Promise<ReadResult<ClineApiMessage[]>> {
  const { parsed, warning } = await readJson(filePath, API_CONVERSATION_HISTORY_FILE);
  if (warning) return { value: [], warning };
  if (parsed === undefined) return { value: [] };
  if (!Array.isArray(parsed)) {
    return {
      value: [],
      warning: `${API_CONVERSATION_HISTORY_FILE} had unexpected shape (expected JSON array)`,
    };
  }
  return {
    value: parsed.map(normalizeApiMessage).filter((message): message is ClineApiMessage => message !== null),
  };
}

async function readTaskMetadata(filePath: string): Promise<ReadResult<ClineTaskMetadata | undefined>> {
  const { parsed, warning } = await readJson(filePath, TASK_METADATA_FILE);
  if (warning) return { value: undefined, warning };
  return { value: normalizeTaskMetadata(parsed) };
}

function taskHistoryArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const taskHistory = value.taskHistory ?? value.history ?? value.items ?? value.entries;
    if (Array.isArray(taskHistory)) return taskHistory;
  }
  return [];
}

interface TaskHistoryReadResult {
  map: TaskHistoryMap;
  warnings: string[];
}

async function readTaskHistoryMap(paths: string[]): Promise<TaskHistoryReadResult> {
  const itemsById: TaskHistoryMap = new Map();
  const warnings: string[] = [];
  for (const filePath of paths) {
    const { parsed, warning } = await readJson(filePath, TASK_HISTORY_FILE);
    if (warning) warnings.push(warning);
    for (const item of taskHistoryArray(parsed).map(normalizeTaskHistoryItem)) {
      if (item && !itemsById.has(item.id)) itemsById.set(item.id, item);
    }
  }
  return { map: itemsById, warnings };
}

async function readTaskHistoryItemFile(
  filePath: string,
  taskId: string,
): Promise<{ item?: ClineTaskHistoryItem; warning?: string }> {
  const { parsed, warning } = await readJson(filePath, HISTORY_ITEM_FILE);
  if (warning) return { warning };
  if (parsed === undefined) return {};

  const item = normalizeTaskHistoryItem(parsed);
  if (!item) {
    return { warning: `${HISTORY_ITEM_FILE} had unexpected shape (expected JSON object)` };
  }
  return item.id === taskId ? { item } : {};
}

async function readTaskHistoryItem(
  paths: string[],
  taskId: string,
): Promise<{ item?: ClineTaskHistoryItem; warnings: string[] }> {
  const { map, warnings } = await readTaskHistoryMap(paths);
  return { item: map.get(taskId), warnings };
}

function taskHistoryCandidatesFromStorageRoot(storageRoot: string): string[] {
  return [
    path.join(storageRoot, 'state', TASK_HISTORY_FILE),
    path.join(storageRoot, TASK_HISTORY_FILE),
    path.join(storageRoot, 'tasks', HISTORY_INDEX_FILE),
    path.join(storageRoot, HISTORY_INDEX_FILE),
  ];
}

function taskFilesFromDir(taskDir: string, storageRoot: string): TaskFiles {
  return {
    taskDir,
    storageRoot,
    uiMessages: path.join(taskDir, UI_MESSAGES_FILE),
    apiConversationHistory: path.join(taskDir, API_CONVERSATION_HISTORY_FILE),
    taskMetadata: path.join(taskDir, TASK_METADATA_FILE),
    historyItem: path.join(taskDir, HISTORY_ITEM_FILE),
    taskHistoryCandidates: taskHistoryCandidatesFromStorageRoot(storageRoot),
  };
}

function inferTaskDirFromOriginalPath(originalPath: string): string {
  return path.extname(originalPath) === '.json' ? path.dirname(originalPath) : originalPath;
}

function inferStorageRootFromTaskDir(taskDir: string): string {
  const parent = path.dirname(taskDir);
  return path.basename(parent) === 'tasks' ? path.dirname(parent) : parent;
}

async function loadTaskData(
  taskDir: string,
  storageRoot: string,
  taskId: string,
  cachedHistory?: TaskHistoryReadResult,
): Promise<LoadedTaskData> {
  const files = taskFilesFromDir(taskDir, storageRoot);
  const [uiResult, apiResult, metadataResult, perTaskHistoryResult, historyResult] = await Promise.all([
    readUiMessages(files.uiMessages),
    readApiConversationHistory(files.apiConversationHistory),
    readTaskMetadata(files.taskMetadata),
    readTaskHistoryItemFile(files.historyItem, taskId),
    cachedHistory
      ? Promise.resolve({ item: cachedHistory.map.get(taskId), warnings: cachedHistory.warnings })
      : readTaskHistoryItem(files.taskHistoryCandidates, taskId),
  ]);

  const fidelityWarnings: string[] = [];
  if (uiResult.warning) fidelityWarnings.push(uiResult.warning);
  if (apiResult.warning) fidelityWarnings.push(apiResult.warning);
  if (metadataResult.warning) fidelityWarnings.push(metadataResult.warning);
  if (perTaskHistoryResult.warning) fidelityWarnings.push(perTaskHistoryResult.warning);
  // taskHistory warnings are de-duplicated because the cached result may be
  // shared across sibling tasks under the same storage root.
  for (const warning of historyResult.warnings) {
    if (!fidelityWarnings.includes(warning)) fidelityWarnings.push(warning);
  }

  return {
    files,
    uiMessages: uiResult.value,
    apiMessages: apiResult.value,
    taskMetadata: metadataResult.value,
    taskHistoryItem: perTaskHistoryResult.item ?? historyResult.item,
    fidelityWarnings,
  };
}

async function loadTaskDataFromOriginalPath(originalPath: string, taskId: string): Promise<LoadedTaskData> {
  const taskDir = inferTaskDirFromOriginalPath(originalPath);
  return loadTaskData(taskDir, inferStorageRootFromTaskDir(taskDir), taskId);
}

function messageText(msg: ClineRawMessage): string | undefined {
  return msg.say === 'reasoning' ? (msg.reasoning ?? msg.text) : msg.text;
}

function apiContentBlocks(content: ClineApiMessage['content']): ClineApiContentBlock[] {
  return Array.isArray(content) ? content : [];
}

function apiMessageText(message: ClineApiMessage): string {
  if (typeof message.content === 'string') return message.content.trim();

  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    if (block.type === 'thinking' && block.thinking) parts.push(block.thinking);
  }
  return parts.join('\n').trim();
}

function extractToolResultText(block: ClineApiContentBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';

  const parts: string[] = [];
  for (const item of block.content) {
    if (!isRecord(item)) continue;
    const type = readString(item, 'type');
    const text = readString(item, 'text');
    if (type === 'text' && text) parts.push(text);
  }
  return parts.join('\n');
}

function getToolResultMap(messages: ClineApiMessage[]): Map<string, ToolResultEntry> {
  const results = new Map<string, ToolResultEntry>();
  for (const message of messages) {
    for (const block of apiContentBlocks(message.content)) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      results.set(block.tool_use_id, {
        text: extractToolResultText(block),
        isError: block.is_error === true,
      });
    }
  }
  return results;
}

function buildApiConversation(messages: ClineApiMessage[], config: VerbosityConfig): ConversationMessage[] {
  const resultMap = getToolResultMap(messages);
  const conversation: ConversationMessage[] = [];

  for (const message of messages) {
    const text = message.role === 'user' ? stripEnvironmentDetails(apiMessageText(message)) : apiMessageText(message);
    const toolCalls: ToolCall[] = [];
    const hasNonToolResultContent = typeof message.content === 'string' || text.length > 0;

    for (const block of apiContentBlocks(message.content)) {
      if (block.type !== 'tool_use' || !block.name) continue;
      const resultEntry = block.id ? resultMap.get(block.id) : undefined;
      toolCalls.push({
        name: block.name,
        id: block.id,
        arguments: block.input ?? {},
        ...(resultEntry?.text ? { result: truncate(resultEntry.text, config.mcp.resultChars) } : {}),
        ...(resultEntry ? { success: !resultEntry.isError } : {}),
      });
    }

    if (!hasNonToolResultContent && toolCalls.length === 0) continue;
    if (!hasNonToolResultContent && apiContentBlocks(message.content).every((block) => block.type === 'tool_result'))
      continue;

    const content =
      text || (toolCalls.length > 0 ? `[Used tools: ${toolCalls.map((toolCall) => toolCall.name).join(', ')}]` : '');
    if (!content) continue;

    conversation.push({
      role: message.role,
      content,
      timestamp: message.ts ? new Date(message.ts) : undefined,
      sourceId: message.id,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }

  return conversation;
}

function isApiRequestMetadata(msg: ClineRawMessage): boolean {
  return msg.type === 'say' && (msg.say === 'api_req_started' || msg.say === 'api_req_finished');
}

function parseJsonRecord(value: unknown, context: string): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch (err) {
    logger.debug('kilo-code: failed to parse SQLite JSON', context, err);
    return null;
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (value?.trim()) return value;
  }
  return undefined;
}

function previewValue(value: unknown, maxLength = 160): string {
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim(), maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  try {
    return truncate(JSON.stringify(value).replace(/\s+/g, ' ').trim(), maxLength);
  } catch (err) {
    logger.debug('kilo-code: failed to stringify SQLite part preview', err);
    return '';
  }
}

function timestampFromValue(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function roleFromMessageData(data: Record<string, unknown>): ConversationMessage['role'] | null {
  const role = readString(data, 'role');
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  return null;
}

/**
 * Convert a Kilo part record into a single-line preview string for the
 * cross-tool handoff conversation.
 *
 * Design decision (per PR open question on tool-part fidelity):
 *   We summarize tool / patch / snapshot / agent / compaction / file / subtask
 *   parts as `[type] preview` text rather than projecting them as structured
 *   ConversationMessage.toolCall records. The rest of the Cline-family pipeline
 *   feeds a markdown handoff (see `generateHandoffMarkdown`) — preview text
 *   keeps the next-tool prompt compact, faithful to source ordering, and
 *   consistent with how the legacy `ui_messages.json` path already flattens
 *   tool activity into prose. Promoting these to structured tool calls would
 *   require a parallel toolSummaries pipeline that the handoff renderer does
 *   not currently consume.
 *
 * Part types covered (Kilo MessageV2 schema, packages/opencode/src/session/message-v2.ts):
 *   text, reasoning, tool, file, snapshot, patch, agent, compaction, subtask, retry
 *
 * Part types intentionally elided (internal markers without user-meaningful prose):
 *   step-start, step-finish — token totals are read at the message level via
 *   `addKiloTokenUsage`; carrying them in conversation would dilute signal.
 */
function extractKiloPartContent(partData: Record<string, unknown>): string {
  const type = readString(partData, 'type');

  if (type === 'text') {
    return firstString(partData, ['text', 'content', 'message']) ?? '';
  }

  if (type === 'reasoning') {
    const text = firstString(partData, ['text', 'summary', 'content']);
    return text ? `[reasoning] ${text}` : '';
  }

  if (type === 'tool') {
    const toolName = readString(partData, 'tool') ?? readString(partData, 'name') ?? 'tool';
    const state = readRecord(partData, 'state');
    const status = state ? readString(state, 'status') : undefined;
    const input = state ? previewValue(state.input, 90) : previewValue(partData.input, 90);
    const output = state
      ? previewValue(state.output ?? state.error, 120)
      : previewValue(partData.output ?? partData.error, 120);
    const label = status && status !== 'completed' ? `[tool:${toolName}:${status}]` : `[tool:${toolName}]`;
    return [label, input, output].filter(Boolean).join(' ');
  }

  if (type === 'file') {
    const filename = readString(partData, 'filename') ?? readString(partData, 'name') ?? '';
    const mime = readString(partData, 'mime') ?? readString(partData, 'mediaType');
    const url = readString(partData, 'url');
    const descriptor = filename || url || mime || 'attachment';
    return mime && filename ? `[file] ${descriptor} (${mime})` : `[file] ${descriptor}`;
  }

  if (type === 'subtask') {
    const agent = readString(partData, 'agent') ?? 'subtask';
    const description = firstString(partData, ['description', 'prompt', 'command']) ?? '';
    return description ? `[subtask:${agent}] ${description}` : `[subtask:${agent}]`;
  }

  if (type === 'retry') {
    const attempt = readNumber(partData, 'attempt');
    const error = readRecord(partData, 'error');
    const errorMessage =
      (error && firstString(error, ['message', 'name', 'code'])) ?? readString(partData, 'error') ?? '';
    const prefix = attempt !== undefined ? `[retry:${attempt}]` : '[retry]';
    return errorMessage ? `${prefix} ${errorMessage}` : prefix;
  }

  if (type === 'patch' || type === 'snapshot' || type === 'agent' || type === 'compaction') {
    const preview = firstString(partData, ['text', 'summary', 'content', 'diff', 'message']) ?? previewValue(partData);
    return preview ? `[${type}] ${preview}` : '';
  }

  // step-start, step-finish: deliberately empty — tracked at message level only.
  return '';
}

function addKiloTokenUsage(notes: SessionNotes, messageData: Record<string, unknown>): void {
  const tokens = readRecord(messageData, 'tokens');
  const usage = readRecord(messageData, 'usage');
  if (!tokens && !usage) return;

  const input =
    (tokens && (readNumber(tokens, 'input') ?? readNumber(tokens, 'inputTokens'))) ??
    (usage && (readNumber(usage, 'input_tokens') ?? readNumber(usage, 'inputTokens'))) ??
    0;
  const output =
    (tokens && (readNumber(tokens, 'output') ?? readNumber(tokens, 'outputTokens'))) ??
    (usage && (readNumber(usage, 'output_tokens') ?? readNumber(usage, 'outputTokens'))) ??
    0;

  if (input > 0 || output > 0) {
    notes.tokenUsage = {
      input: (notes.tokenUsage?.input ?? 0) + input,
      output: (notes.tokenUsage?.output ?? 0) + output,
    };
  }

  const reasoning =
    (tokens && readNumber(tokens, 'reasoning')) ?? (usage && readNumber(usage, 'reasoning_tokens')) ?? 0;
  if (reasoning > 0) notes.thinkingTokens = (notes.thinkingTokens ?? 0) + reasoning;

  const cache = tokens && readRecord(tokens, 'cache');
  const cacheRead =
    (cache && readNumber(cache, 'read')) ??
    (tokens && readNumber(tokens, 'cacheRead')) ??
    (usage && readNumber(usage, 'cache_read_input_tokens')) ??
    0;
  const cacheCreation =
    (cache && (readNumber(cache, 'write') ?? readNumber(cache, 'creation'))) ??
    (tokens && readNumber(tokens, 'cacheWrite')) ??
    (usage && readNumber(usage, 'cache_creation_input_tokens')) ??
    0;

  if (cacheRead > 0 || cacheCreation > 0) {
    notes.cacheTokens = {
      read: (notes.cacheTokens?.read ?? 0) + cacheRead,
      creation: (notes.cacheTokens?.creation ?? 0) + cacheCreation,
    };
  }
}

function addKiloReasoning(partData: Record<string, unknown>, reasoning: string[], maxHighlights: number): void {
  if (reasoning.length >= maxHighlights || readString(partData, 'type') !== 'reasoning') return;
  const text = firstString(partData, ['text', 'summary', 'content']);
  if (!text || text.length < 10) return;
  reasoning.push(truncate(text.trim(), 200));
}

function selectColumns(columns: Set<string>, preferred: readonly string[]): string {
  return preferred.filter((column) => columns.has(column)).join(', ');
}

function orderBy(columns: Set<string>, preferred: string, fallback: string): string {
  if (columns.has(preferred) && columns.has(fallback)) return `${preferred} ASC, ${fallback} ASC`;
  if (columns.has(preferred)) return `${preferred} ASC`;
  if (columns.has(fallback)) return `${fallback} ASC`;
  return 'rowid ASC';
}

interface KiloDbDiscoverySummary {
  rowCount: number;
  firstUserMessage: string;
  model?: string;
  firstTimestamp?: Date;
  lastTimestamp?: Date;
}

/**
 * Lightweight summary used during session discovery.
 *
 * Issues a single message query (no parts) to determine row count and
 * timestamps, then makes at most two follow-up part queries to recover
 * the first-user content (for summary fallback) and model (for the
 * unified session card). Avoids the N+1 message/part scan that the
 * full extraction path requires, so listing remains fast on large DBs.
 */
function readKiloDbDiscoverySummary(
  db: SqliteDatabase,
  schema: KiloDbSchema,
  sessionId: string,
): KiloDbDiscoverySummary {
  const messageColumns = selectColumns(schema.message, ['id', 'time_created', 'data']);
  let msgRows: unknown[];
  try {
    msgRows = db
      .prepare(
        `SELECT ${messageColumns} FROM message WHERE session_id = ? ORDER BY ${orderBy(schema.message, 'time_created', 'id')}`,
      )
      .all(sessionId);
  } catch (err) {
    logger.debug('kilo-code: failed to read message metadata for discovery', sessionId, err);
    return { rowCount: 0, firstUserMessage: '' };
  }

  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;
  let firstUserMessageId: string | undefined;
  let firstAssistantMessageId: string | undefined;
  let model: string | undefined;

  for (const msgRow of msgRows) {
    if (!isRecord(msgRow)) continue;
    const messageId = readString(msgRow, 'id');
    if (!messageId) continue;

    const messageData = parseJsonRecord(msgRow.data, `message:${messageId}`);
    if (!messageData) continue;

    const role = roleFromMessageData(messageData);
    if (!role) continue;

    const timestamp = timestampFromValue(msgRow.time_created);
    if (timestamp) {
      if (!firstTimestamp || timestamp.getTime() < firstTimestamp.getTime()) firstTimestamp = timestamp;
      if (!lastTimestamp || timestamp.getTime() > lastTimestamp.getTime()) lastTimestamp = timestamp;
    }

    if (role === 'user' && !firstUserMessageId) firstUserMessageId = messageId;
    if (role === 'assistant' && !firstAssistantMessageId) {
      firstAssistantMessageId = messageId;
      if (!model) {
        model = firstString(messageData, ['modelID', 'modelId', 'model', 'providerID', 'providerId']);
      }
    }

    if (firstUserMessageId && firstAssistantMessageId && model) break;
  }

  const firstUserMessage = firstUserMessageId ? readKiloDbPartsContent(db, schema, firstUserMessageId) : '';

  return {
    rowCount: msgRows.length,
    firstUserMessage,
    model,
    firstTimestamp,
    lastTimestamp,
  };
}

/** Read and concatenate the text content of all parts for a single message. */
function readKiloDbPartsContent(db: SqliteDatabase, schema: KiloDbSchema, messageId: string): string {
  const partColumns = selectColumns(schema.part, ['id', 'message_id', 'time_created', 'data']);
  let partRows: unknown[];
  try {
    partRows = db
      .prepare(
        `SELECT ${partColumns} FROM part WHERE message_id = ? ORDER BY ${orderBy(schema.part, 'time_created', 'id')}`,
      )
      .all(messageId);
  } catch (err) {
    logger.debug('kilo-code: failed to read part rows', messageId, err);
    return '';
  }

  const contentParts: string[] = [];
  for (const partRow of partRows) {
    if (!isRecord(partRow)) continue;
    const partData = parseJsonRecord(partRow.data, `part:${messageId}`);
    if (!partData) continue;
    const content = extractKiloPartContent(partData).trim();
    if (content) contentParts.push(content);
  }
  return contentParts.join('\n').trim();
}

function readKiloDbMessagesFromHandle(
  db: SqliteDatabase,
  schema: KiloDbSchema,
  sessionId: string,
  maxReasoningHighlights = 10,
): KiloDbMessageRead {
  const messageColumns = selectColumns(schema.message, ['id', 'session_id', 'time_created', 'data']);
  const partColumns = selectColumns(schema.part, ['id', 'message_id', 'time_created', 'data']);
  const msgRows = db
    .prepare(
      `SELECT ${messageColumns} FROM message WHERE session_id = ? ORDER BY ${orderBy(schema.message, 'time_created', 'id')}`,
    )
    .all(sessionId);

  const messages: ConversationMessage[] = [];
  const notes: SessionNotes = {};
  const reasoning: string[] = [];
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;

  for (const msgRow of msgRows) {
    if (!isRecord(msgRow)) continue;
    const messageId = readString(msgRow, 'id');
    if (!messageId) continue;

    const messageData = parseJsonRecord(msgRow.data, `message:${messageId}`);
    if (!messageData) continue;

    const role = roleFromMessageData(messageData);
    if (!role) continue;

    const timestamp = timestampFromValue(msgRow.time_created);
    if (timestamp) {
      if (!firstTimestamp || timestamp.getTime() < firstTimestamp.getTime()) firstTimestamp = timestamp;
      if (!lastTimestamp || timestamp.getTime() > lastTimestamp.getTime()) lastTimestamp = timestamp;
    }

    if (role === 'assistant' && !notes.model) {
      notes.model = firstString(messageData, ['modelID', 'modelId', 'model', 'providerID', 'providerId']) ?? undefined;
    }
    addKiloTokenUsage(notes, messageData);

    const partRows = db
      .prepare(
        `SELECT ${partColumns} FROM part WHERE message_id = ? ORDER BY ${orderBy(schema.part, 'time_created', 'id')}`,
      )
      .all(messageId);

    const contentParts: string[] = [];
    for (const partRow of partRows) {
      if (!isRecord(partRow)) continue;
      const partData = parseJsonRecord(partRow.data, `part:${messageId}`);
      if (!partData) continue;

      const content = extractKiloPartContent(partData).trim();
      if (content) contentParts.push(content);
      addKiloReasoning(partData, reasoning, maxReasoningHighlights);
    }

    const content = contentParts.join('\n').trim();
    if (content) messages.push({ role, content, timestamp, sourceId: messageId });
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  if (firstTimestamp && lastTimestamp && lastTimestamp.getTime() >= firstTimestamp.getTime()) {
    notes.activeTimeMs = lastTimestamp.getTime() - firstTimestamp.getTime();
  }

  return { messages, notes, rowCount: msgRows.length, firstTimestamp, lastTimestamp };
}

function getProjectWorktree(db: SqliteDatabase, schema: KiloDbSchema, projectId: string | undefined): string {
  if (!projectId || !schema.project.has('id') || !schema.project.has('worktree')) return '';
  try {
    const row = db.prepare('SELECT worktree FROM project WHERE id = ?').get(projectId);
    return isRecord(row) ? (readString(row, 'worktree') ?? '') : '';
  } catch (err) {
    logger.debug('kilo-code: failed to read SQLite project row', projectId, err);
    return '';
  }
}

function sessionSourceMetadata(row: Record<string, unknown>, dbPath: string): Record<string, unknown> {
  return {
    storage: 'sqlite',
    dbPath,
    ...(readString(row, 'slug') ? { slug: readString(row, 'slug') } : {}),
    ...(readString(row, 'version') ? { version: readString(row, 'version') } : {}),
    ...(readString(row, 'project_id') ? { projectId: readString(row, 'project_id') } : {}),
  };
}

function isUnhelpfulDbTitle(title: string): boolean {
  return title.trim().length === 0 || /^new session\b/iu.test(title.trim());
}

/**
 * Determine conversation role from a raw Cline message.
 * Returns null for messages that aren't conversation turns (metadata, api events).
 */
function classifyRole(msg: ClineRawMessage, state: ConversationState): ConversationRole | null {
  if (msg.type === 'ask') {
    switch (msg.ask) {
      case 'followup':
      case 'plan_mode_respond':
      case 'act_mode_respond':
      case 'completion_result':
      case 'resume_task':
      case 'resume_completed_task':
      case 'mistake_limit_reached':
      case 'api_req_failed':
      case 'new_task':
      case 'condense':
      case 'summarize_task':
      case 'report_bug':
        return 'assistant';

      default:
        return null;
    }
  }

  if (msg.type !== 'say') return null;

  switch (msg.say) {
    case 'task':
    case 'user_feedback':
    case 'user_feedback_diff':
      return 'user';

    case 'text':
      // Roo Code stores the initial user task as the first text message.
      // Once an API request exists, text messages are assistant output, including
      // partial:false finalizations of prior streaming assistant chunks.
      return state.hasSeenApiRequest || msg.partial !== undefined ? 'assistant' : 'user';

    case 'completion_result':
    case 'reasoning':
      return 'assistant';

    default:
      // api_req_started, api_req_finished, and other event types → not conversation
      return null;
  }
}

/**
 * Extract the first real user message from a set of raw messages.
 * Used for session summary during discovery, where we may scan thousands of
 * messages but only need the first user hit. Iterates raw messages directly
 * with the same role classification as `buildConversation`, avoiding the
 * full conversation rebuild for large sessions.
 */
function extractFirstUserMessage(messages: ClineRawMessage[]): string {
  const state: ConversationState = { hasSeenApiRequest: false };
  for (const msg of messages) {
    const role = classifyRole(msg, state);
    if (isApiRequestMetadata(msg)) state.hasSeenApiRequest = true;
    if (role !== 'user') continue;
    const content = messageText(msg);
    if (!content) continue;
    const text = content.trim();
    if (text) return text;
  }
  return '';
}

/**
 * Build conversation messages from raw Cline events.
 * Deduplicates consecutive assistant streaming chunks (keeps last = most complete).
 */
function buildConversation(messages: ClineRawMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  const state: ConversationState = { hasSeenApiRequest: false };
  let streamState: StreamState | undefined;

  for (const msg of messages) {
    const role = classifyRole(msg, state);
    if (isApiRequestMetadata(msg)) state.hasSeenApiRequest = true;
    if (!role) continue;

    const content = messageText(msg);
    if (!content) continue;

    const text = content.trim();
    if (!text) continue;

    const ts = msg.ts ? new Date(msg.ts) : undefined;
    const kind = `${msg.type}:${msg.type === 'ask' ? msg.ask : msg.say}`;
    const canReplaceStream =
      role === 'assistant' &&
      streamState?.index === result.length - 1 &&
      streamState.role === role &&
      streamState.kind === kind;

    // Consecutive partial updates represent the same assistant message evolving
    // over time. Keep only the latest visible state, including partial:false
    // finalizations of the same message.
    if (canReplaceStream && (msg.partial === true || msg.partial === false)) {
      result[result.length - 1] = { role, content: text, timestamp: ts };
    } else {
      result.push({ role, content: text, timestamp: ts });
    }

    streamState =
      role === 'assistant' && msg.partial === true
        ? { index: result.length - 1, role, kind }
        : msg.partial === false
          ? undefined
          : streamState;
  }

  return result;
}

// ── Token / Cost Extraction ─────────────────────────────────────────────────

/**
 * Cline-canonical usage events. Mirrors upstream `getApiMetrics`
 * (src/shared/getApiMetrics.ts), which iterates these three event kinds and
 * sums their per-request `tokensIn / tokensOut / cacheWrites / cacheReads`
 * fields:
 *   - `api_req_started` — current per-request usage (post-finalization)
 *   - `deleted_api_reqs` — aggregated usage from history truncation
 *   - `subagent_usage`  — aggregated usage from subagent batches
 *
 * `api_req_finished` is intentionally excluded: upstream comments call it
 * "legacy" and it's no longer emitted; including it would double-count old
 * tasks where both events exist with the same per-request fields.
 */
const TOKEN_USAGE_SAYS = new Set(['api_req_started', 'deleted_api_reqs', 'subagent_usage']);

/**
 * Aggregate token usage from Cline UI events. Reads per-request deltas from
 * `api_req_started`, plus aggregated deltas from `deleted_api_reqs` and
 * `subagent_usage`, matching upstream `getApiMetrics` exactly.
 */
function extractTokenUsage(messages: ClineRawMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheWrites = 0;
  let totalCacheReads = 0;
  let found = false;

  for (const msg of messages) {
    if (msg.type !== 'say' || !msg.say || !TOKEN_USAGE_SAYS.has(msg.say)) continue;
    if (!msg.text) continue;

    try {
      const parsed: unknown = JSON.parse(msg.text);
      if (!isRecord(parsed)) continue;

      const tokensIn = readNumber(parsed, 'tokensIn');
      if (tokensIn !== undefined) {
        totalIn += tokensIn;
        found = true;
      }
      const tokensOut = readNumber(parsed, 'tokensOut');
      if (tokensOut !== undefined) {
        totalOut += tokensOut;
        found = true;
      }
      const cacheWrites = readNumber(parsed, 'cacheWrites');
      if (cacheWrites !== undefined) {
        totalCacheWrites += cacheWrites;
        found = true;
      }
      const cacheReads = readNumber(parsed, 'cacheReads');
      if (cacheReads !== undefined) {
        totalCacheReads += cacheReads;
        found = true;
      }
    } catch (err) {
      logger.debug('cline: skipping malformed API request metadata', err);
    }
  }

  if (found) {
    notes.tokenUsage = { input: totalIn, output: totalOut };
  }
  if (totalCacheWrites > 0 || totalCacheReads > 0) {
    notes.cacheTokens = { creation: totalCacheWrites, read: totalCacheReads };
  }

  return notes;
}

function extractRooTokenUsage(messages: ClineRawMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  let incIn = 0;
  let incOut = 0;
  let incCacheWrites = 0;
  let incCacheReads = 0;
  let cumIn: number | undefined;
  let cumOut: number | undefined;
  let cumCacheWrites: number | undefined;
  let cumCacheReads: number | undefined;
  let foundIncremental = false;
  const trackMax = (current: number | undefined, next: number): number =>
    current === undefined ? next : Math.max(current, next);

  for (const msg of messages) {
    if (msg.type !== 'say' || (msg.say !== 'api_req_started' && msg.say !== 'api_req_finished')) continue;
    if (!msg.text) continue;

    try {
      const parsed: unknown = JSON.parse(msg.text);
      if (!isRecord(parsed)) continue;

      const totalTokensIn = readNumber(parsed, 'totalTokensIn');
      const totalTokensOut = readNumber(parsed, 'totalTokensOut');
      const totalCacheWrites = readNumber(parsed, 'totalCacheWrites');
      const totalCacheReads = readNumber(parsed, 'totalCacheReads');
      if (totalTokensIn !== undefined) cumIn = trackMax(cumIn, totalTokensIn);
      if (totalTokensOut !== undefined) cumOut = trackMax(cumOut, totalTokensOut);
      if (totalCacheWrites !== undefined) cumCacheWrites = trackMax(cumCacheWrites, totalCacheWrites);
      if (totalCacheReads !== undefined) cumCacheReads = trackMax(cumCacheReads, totalCacheReads);

      const tokensIn = readNumber(parsed, 'tokensIn');
      const tokensOut = readNumber(parsed, 'tokensOut');
      const cacheWrites = readNumber(parsed, 'cacheWrites');
      const cacheReads = readNumber(parsed, 'cacheReads');
      if (tokensIn !== undefined) {
        incIn += tokensIn;
        foundIncremental = true;
      }
      if (tokensOut !== undefined) {
        incOut += tokensOut;
        foundIncremental = true;
      }
      if (cacheWrites !== undefined) {
        incCacheWrites += cacheWrites;
        foundIncremental = true;
      }
      if (cacheReads !== undefined) {
        incCacheReads += cacheReads;
        foundIncremental = true;
      }
    } catch (err) {
      logger.debug('cline: skipping malformed Roo API request metadata', err);
    }
  }

  const hasCumulative = cumIn !== undefined || cumOut !== undefined;
  if (hasCumulative) {
    notes.tokenUsage = { input: cumIn ?? 0, output: cumOut ?? 0 };
  } else if (foundIncremental) {
    notes.tokenUsage = { input: incIn, output: incOut };
  }

  const cacheCreation = cumCacheWrites ?? incCacheWrites;
  const cacheRead = cumCacheReads ?? incCacheReads;
  if (cacheCreation > 0 || cacheRead > 0) {
    notes.cacheTokens = { creation: cacheCreation, read: cacheRead };
  }

  return notes;
}

function extractUsageFromTaskHistory(item?: ClineTaskHistoryItem): SessionNotes {
  const notes: SessionNotes = {};
  if (!item) return notes;

  if (item.tokensIn !== undefined || item.tokensOut !== undefined) {
    notes.tokenUsage = {
      input: item.tokensIn ?? 0,
      output: item.tokensOut ?? 0,
    };
  }
  if (item.cacheWrites !== undefined || item.cacheReads !== undefined) {
    notes.cacheTokens = {
      creation: item.cacheWrites ?? 0,
      read: item.cacheReads ?? 0,
    };
  }
  return notes;
}

function extractUsageFromApiHistory(messages: ClineApiMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let found = false;

  for (const message of messages) {
    const metrics = message.metrics;
    if (!metrics) continue;
    const tokens = readRecord(metrics, 'tokens');

    const prompt = tokens ? readNumber(tokens, 'prompt') : readNumber(metrics, 'tokensIn');
    const completion = tokens ? readNumber(tokens, 'completion') : readNumber(metrics, 'tokensOut');
    const cached = tokens ? readNumber(tokens, 'cached') : readNumber(metrics, 'cacheReads');

    if (prompt !== undefined) {
      input += prompt;
      found = true;
    }
    if (completion !== undefined) {
      output += completion;
      found = true;
    }
    if (cached !== undefined) {
      cacheRead += cached;
    }
  }

  if (found) notes.tokenUsage = { input, output };
  if (cacheRead > 0) notes.cacheTokens = { creation: 0, read: cacheRead };
  return notes;
}

/**
 * Resolve token usage notes for a task.
 *
 * Precedence (highest first):
 *   1. `taskHistory.json` `{tokensIn, tokensOut, cacheWrites, cacheReads}` —
 *      Cline writes the canonical *post-finalization* totals here. Used
 *      first because it's the same number Cline shows in its history UI.
 *   2. `api_conversation_history.json` per-message `metrics.tokens` /
 *      `metrics.tokensIn` — Cline records per-API-turn telemetry on each
 *      assistant message. Summing these reproduces (1) for tasks where (1)
 *      hasn't been written yet, and avoids the third source.
 *   3. `ui_messages.json` per-event aggregation — sums per-request deltas
 *      from `api_req_started` plus aggregated deltas from
 *      `deleted_api_reqs` and `subagent_usage`, mirroring upstream
 *      `getApiMetrics`. Used last because it requires reading the UI log,
 *      which is the largest of the three companion files.
 *
 * The three sources are mutually consistent in current Cline; precedence
 * picks the cheapest source available, not the "best" number. Because a
 * single source is chosen, the totals are never double-counted across
 * UI/API/history.
 */
function chooseUsageNotes(data: LoadedTaskData, source: ClineSource): SessionNotes {
  const fromHistory = extractUsageFromTaskHistory(data.taskHistoryItem);
  if (fromHistory.tokenUsage || fromHistory.cacheTokens) return fromHistory;

  const fromApiHistory = extractUsageFromApiHistory(data.apiMessages);
  if (fromApiHistory.tokenUsage || fromApiHistory.cacheTokens) return fromApiHistory;

  return source === 'roo-code' ? extractRooTokenUsage(data.uiMessages) : extractTokenUsage(data.uiMessages);
}

/**
 * Extract reasoning highlights from "reasoning" say events (max N).
 */
function extractReasoning(messages: ClineRawMessage[], max: number): string[] {
  const highlights: string[] = [];
  for (const msg of messages) {
    if (highlights.length >= max) break;
    if (msg.type !== 'say' || msg.say !== 'reasoning') continue;
    const content = messageText(msg);
    if (!content || content.length < 10) continue;
    highlights.push(truncate(content.trim(), 200));
  }
  return highlights;
}

function extractApiReasoning(messages: ClineApiMessage[], max: number): string[] {
  const highlights: string[] = [];
  for (const message of messages) {
    if (highlights.length >= max) break;
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;

    for (const block of message.content) {
      if (highlights.length >= max) break;
      const text = block.type === 'thinking' ? block.thinking : undefined;
      if (!text || text.length < 10) continue;
      highlights.push(truncate(text.trim(), 200));
    }
  }
  return highlights;
}

/**
 * Extract pending tasks from the last assistant message.
 * Looks for TODO, NEXT, REMAINING patterns in completion results.
 */
function extractPendingTasks(messages: ClineRawMessage[], max: number): string[] {
  const tasks: string[] = [];

  // Walk backwards to find the last completion_result or assistant text
  for (let i = messages.length - 1; i >= 0 && tasks.length < max; i--) {
    const msg = messages[i];
    const isCompletion =
      (msg.type === 'say' && (msg.say === 'completion_result' || msg.say === 'text')) ||
      (msg.type === 'ask' && msg.ask === 'completion_result');
    if (!isCompletion) continue;
    if (!msg.text) continue;

    const lines = msg.text.split('\n');
    for (const line of lines) {
      if (tasks.length >= max) break;
      const trimmed = line.trim();
      const lower = trimmed.toLowerCase();
      if (
        (lower.startsWith('- [ ]') || lower.startsWith('todo:') || lower.includes('next step')) &&
        trimmed.length > 5
      ) {
        tasks.push(truncate(trimmed, 200));
      }
    }

    // Only check the last relevant message
    if (tasks.length > 0) break;
  }

  return tasks;
}

function pendingLinesFromText(text: string, max: number): string[] {
  const tasks: string[] = [];
  for (const line of text.split('\n')) {
    if (tasks.length >= max) break;
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if ((lower.startsWith('- [ ]') || lower.startsWith('todo:') || lower.includes('next step')) && trimmed.length > 5) {
      tasks.push(truncate(trimmed, 200));
    }
  }
  return tasks;
}

function extractPendingTasksFromConversation(messages: ConversationMessage[], max: number): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    const tasks = pendingLinesFromText(messages[i].content, max);
    if (tasks.length > 0) return tasks;
  }
  return [];
}

function extractFirstApiUserMessage(messages: ClineApiMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = apiMessageText(message);
    if (text) return stripEnvironmentDetails(text);
  }
  return '';
}

function stripEnvironmentDetails(text: string): string {
  return text.replace(/<environment_details>[\s\S]*?<\/environment_details>/giu, '').trim();
}

function extractModelFromMetadata(metadata?: ClineTaskMetadata): string | undefined {
  const lastModel = metadata?.model_usage?.at(-1);
  return lastModel ? (readString(lastModel, 'model_id') ?? readString(lastModel, 'modelId')) : undefined;
}

function extractModelFromApiHistory(messages: ClineApiMessage[]): string | undefined {
  let model: string | undefined;
  for (const message of messages) {
    if (message.modelInfo?.modelId) model = message.modelInfo.modelId;
  }
  return model;
}

function extractModelFromUiMessages(messages: ClineRawMessage[]): string | undefined {
  let model: string | undefined;
  for (const message of messages) {
    if (message.modelInfo?.modelId) model = message.modelInfo.modelId;
  }
  return model;
}

/**
 * Resolve the active model id for a task.
 *
 * Precedence (highest first):
 *   1. `task_metadata.json` `model_usage` (last entry) — Cline writes a new
 *      entry every time the user picks a model, so the tail is the latest
 *      authoritative choice.
 *   2. `taskHistory.json` `modelId` — Cline updates this index as the task
 *      progresses; the value reflects the model at last activity.
 *   3. `api_conversation_history.json` `modelInfo.modelId` — observed model
 *      on the most recent API turn. Cline persists this on every assistant
 *      message but it can drift if the user switches mid-task.
 *   4. `ui_messages.json` `modelInfo.modelId` — same observation surface as
 *      (3) but in UI form. Used last because it can include UI-only state
 *      that wasn't actually committed to the API conversation.
 *
 * The first three sources are all equally trustworthy for steady-state
 * tasks; the precedence matters only at the moment the user changes models
 * mid-task before metadata is flushed. In that race, (2) and (3) may
 * disagree with (1) and we trust the metadata file as the canonical source.
 */
function resolveModel(data: LoadedTaskData): string | undefined {
  return (
    extractModelFromMetadata(data.taskMetadata) ??
    data.taskHistoryItem?.modelId ??
    extractModelFromApiHistory(data.apiMessages) ??
    extractModelFromUiMessages(data.uiMessages)
  );
}

function buildSourceMetadata(data: LoadedTaskData): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};

  if (data.apiMessages.length > 0) metadata.apiConversationMessages = data.apiMessages.length;
  if (data.taskMetadata) {
    metadata.taskMetadata = {
      ...(data.taskMetadata.files_in_context ? { filesInContext: data.taskMetadata.files_in_context.length } : {}),
      ...(data.taskMetadata.model_usage ? { modelUsage: data.taskMetadata.model_usage.length } : {}),
    };
  }
  if (data.taskHistoryItem) {
    metadata.historyItem = {
      ...(data.taskHistoryItem.status ? { status: data.taskHistoryItem.status } : {}),
      ...(data.taskHistoryItem.mode ? { mode: data.taskHistoryItem.mode } : {}),
      ...(data.taskHistoryItem.apiConfigName ? { apiConfigName: data.taskHistoryItem.apiConfigName } : {}),
    };
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~/') || /^[A-Za-z]:[\\/]/u.test(value);
}

const CWD_KEYS = [
  'cwd',
  'cwdOnTaskInitialization',
  'currentWorkingDirectory',
  'workingDirectory',
  'workspacePath',
  'rootPath',
  'projectRoot',
];

/**
 * Search a JSON value for a working-directory hint without false positives.
 *
 * To avoid mis-classifying arbitrary paths embedded in conversation text
 * (e.g. `/usr/bin/node`) as the cwd, this only accepts path-like strings
 * when they appear:
 *   - directly under a known cwd-bearing key, or
 *   - inside a string that contains an explicit `Current Working Directory ...`
 *     / `cwd: ...` marker recognized by `extractCwdFromText`.
 *
 * Bare path-like strings (or strings nested in unrelated objects/arrays) are
 * treated as untrusted and not returned.
 */
function findCwdInValue(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;

  if (typeof value === 'string') {
    // Only trust strings that carry an explicit "cwd: ..." / "Current Working
    // Directory ..." marker. A bare path-like string is not enough.
    return extractCwdFromText(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const cwd = findCwdInValue(item, depth + 1);
      if (cwd) return cwd;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  // Strongest signal: a known cwd key with a path-like string value.
  for (const key of CWD_KEYS) {
    const raw = readString(value, key);
    if (raw && looksLikePath(raw)) return raw;
  }

  // Fall back to scanning nested values for marker-bearing strings or nested
  // cwd keys. Any path-like leaf strings are still rejected by the typeof
  // 'string' branch above unless they include an explicit marker.
  for (const nested of Object.values(value)) {
    const cwd = findCwdInValue(nested, depth + 1);
    if (cwd) return cwd;
  }

  return undefined;
}

function extractCwdFromUiApiEvents(messages: ClineRawMessage[]): string | undefined {
  for (const message of messages) {
    if (!isApiRequestMetadata(message) || !message.text) continue;
    try {
      const parsed: unknown = JSON.parse(message.text);
      const cwd = findCwdInValue(parsed);
      if (cwd) return cwd;
    } catch (err) {
      logger.debug('cline: skipping malformed API request metadata while extracting cwd', err);
    }
  }
  return undefined;
}

function extractCwdFromText(text: string): string | undefined {
  const patterns = [
    /Current Working Directory\s*\(([^)]+)\)/iu,
    /Current Working Directory\s*:\s*([^\n\r]+)/iu,
    // Stop at whitespace so `cwd: /path some-other-text` does not capture
    // the trailing words. cwd values written in Cline metadata are
    // single tokens.
    /\bcwd\s*[:=]\s*(\S+)/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const cwd = match?.[1]?.trim();
    if (cwd && looksLikePath(cwd)) return cwd;
  }
  return undefined;
}

function extractCwdFromApiHistory(messages: ClineApiMessage[]): string | undefined {
  for (const message of messages) {
    const cwd = extractCwdFromText(apiMessageText(message));
    if (cwd) return cwd;
  }
  return undefined;
}

/**
 * Normalize a working directory to POSIX separators so downstream helpers
 * like `extractRepoFromCwd` (which splits on `/`) handle Windows paths
 * (`C:\Users\me\repo`) correctly.
 */
function normalizeCwd(value: string): string {
  return value.replace(/\\/g, '/');
}

function resolveCwd(data: LoadedTaskData): string {
  const raw =
    data.taskHistoryItem?.cwdOnTaskInitialization ??
    extractCwdFromUiApiEvents(data.uiMessages) ??
    extractCwdFromApiHistory(data.apiMessages) ??
    '';
  return raw ? normalizeCwd(raw) : '';
}

function getInputString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

function stringifyArgs(input: Record<string, unknown>, maxChars: number): string {
  try {
    return truncate(JSON.stringify(input), maxChars);
  } catch (err) {
    logger.debug('cline: failed to stringify tool arguments', err);
    return '';
  }
}

function getToolFilePath(input: Record<string, unknown>): string {
  return getInputString(input, 'path') || getInputString(input, 'file_path') || getInputString(input, 'filePath');
}

function isWriteToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized.includes('write') ||
    normalized.includes('edit') ||
    normalized.includes('replace') ||
    normalized.includes('apply') ||
    normalized.includes('diff') ||
    normalized.includes('patch')
  );
}

function addClineToolSummary(
  collector: SummaryCollector,
  name: string,
  input: Record<string, unknown>,
  result: ToolResultEntry | undefined,
  config: VerbosityConfig,
): void {
  const resultText = result?.text;
  const isError = result?.isError ?? false;
  const filePath = getToolFilePath(input);

  switch (name) {
    case 'execute_command': {
      const command = getInputString(input, 'command') || getInputString(input, 'cmd');
      collector.add(name, shellSummary(command, resultText), {
        data: {
          category: 'shell',
          command,
          ...(resultText ? { stdoutTail: truncate(resultText, config.shell.maxChars) } : {}),
          ...(isError ? { errored: true, errorMessage: truncate(resultText ?? '', config.shell.maxChars) } : {}),
        },
        isError,
      });
      return;
    }

    case 'read_file': {
      collector.add(name, withResult(fileSummary('read', filePath), resultText?.slice(0, 80)), {
        data: { category: 'read', filePath },
        filePath,
        isError,
      });
      return;
    }

    case 'write_to_file': {
      collector.add(name, withResult(fileSummary('write', filePath, undefined, true), resultText?.slice(0, 80)), {
        data: { category: 'write', filePath, isNewFile: true },
        filePath,
        isWrite: true,
        isError,
      });
      return;
    }

    case 'replace_in_file':
    case 'apply_diff': {
      collector.add(name, withResult(fileSummary('edit', filePath), resultText?.slice(0, 80)), {
        data: { category: 'edit', filePath },
        filePath,
        isWrite: true,
        isError,
      });
      return;
    }

    case 'search_files': {
      const pattern =
        getInputString(input, 'regex') || getInputString(input, 'pattern') || getInputString(input, 'query');
      collector.add(name, withResult(grepSummary(pattern, filePath), resultText?.slice(0, 80)), {
        data: { category: 'grep', pattern, ...(filePath ? { targetPath: filePath } : {}) },
        isError,
      });
      return;
    }

    case 'list_files':
    case 'list_code_definition_names': {
      const target = filePath || getInputString(input, 'recursive') || '.';
      collector.add(name, withResult(globSummary(target), resultText?.slice(0, 80)), {
        data: { category: 'glob', pattern: target },
        isError,
      });
      return;
    }

    default: {
      const args = stringifyArgs(input, config.mcp.paramChars);
      collector.add(name, mcpSummary(name, args, resultText?.slice(0, 80)), {
        data: {
          category: 'mcp',
          toolName: name,
          ...(args ? { params: args } : {}),
          ...(resultText ? { result: resultText.slice(0, config.mcp.resultChars) } : {}),
        },
        isError,
      });
    }
  }
}

function firstXmlTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'iu'));
  return match?.[1]?.trim();
}

function parseJsonUiToolRecord(text: string): { toolName?: string; filePath?: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return undefined;

    const toolName =
      readString(parsed, 'tool') ??
      readString(parsed, 'toolName') ??
      readString(parsed, 'tool_name') ??
      readString(parsed, 'name');
    const filePath = getToolFilePath(parsed);
    if (!toolName && !filePath) return undefined;
    return { toolName, filePath };
  } catch (err) {
    logger.debug('cline: skipping malformed UI tool JSON record', err);
    return undefined;
  }
}

function addUiToolSummaries(messages: ClineRawMessage[], collector: SummaryCollector): boolean {
  let addedUiOnlyTool = false;

  for (const msg of messages) {
    if (!msg.text) continue;
    const isToolRequest = (msg.type === 'ask' && msg.ask === 'tool') || (msg.type === 'say' && msg.say === 'tool');
    if (!isToolRequest) continue;

    const jsonRecord = parseJsonUiToolRecord(msg.text);
    const toolName =
      jsonRecord?.toolName ?? firstXmlTag(msg.text, 'tool_name') ?? msg.text.match(/<([a-z][\w-]*)>/iu)?.[1];
    const filePath = jsonRecord?.filePath ?? firstXmlTag(msg.text, 'path') ?? firstXmlTag(msg.text, 'file_path');
    if (!toolName && !filePath) continue;

    const summary = `requested ${toolName ?? 'tool'}${filePath ? ` ${filePath}` : ''}`;
    collector.add(toolName ? `ui:${toolName}` : 'ui:tool', summary, {
      filePath,
      isWrite: filePath ? isWriteToolName(toolName ?? msg.text) : false,
    });
    addedUiOnlyTool = true;
  }

  return addedUiOnlyTool;
}

function addMetadataFiles(taskMetadata: ClineTaskMetadata | undefined, collector: SummaryCollector): void {
  const files = taskMetadata?.files_in_context;
  if (!files) return;

  for (const item of files) {
    const filePath = readString(item, 'path');
    if (!filePath) continue;
    const source = readString(item, 'record_source');
    const edited =
      source === 'cline_edited' ||
      source === 'user_edited' ||
      readNumber(item, 'cline_edit_date') !== undefined ||
      readNumber(item, 'user_edit_date') !== undefined;
    if (edited) collector.trackFile(filePath);
  }
}

function extractToolData(data: LoadedTaskData, config: VerbosityConfig): ToolData {
  const collector = new SummaryCollector(config);
  const resultMap = getToolResultMap(data.apiMessages);

  for (const message of data.apiMessages) {
    for (const block of apiContentBlocks(message.content)) {
      if (block.type !== 'tool_use' || !block.name) continue;
      const result = block.id ? resultMap.get(block.id) : undefined;
      addClineToolSummary(collector, block.name, block.input ?? {}, result, config);
    }
  }

  const hasUiOnlyToolSummaries = addUiToolSummaries(data.uiMessages, collector);
  addMetadataFiles(data.taskMetadata, collector);

  return {
    summaries: collector.getSummaries(),
    filesModified: collector.getFilesModified(),
    fidelityWarnings:
      hasUiOnlyToolSummaries && data.apiMessages.length === 0
        ? ['UI-only tool records are approval/status records; tool results may be incomplete.']
        : [],
  };
}

async function existingCompanionStats(
  files: TaskFiles,
): Promise<Array<{ filePath: string; size: number; birthtime: Date; mtime: Date }>> {
  const stats: Array<{ filePath: string; size: number; birthtime: Date; mtime: Date }> = [];
  for (const filePath of [files.uiMessages, files.apiConversationHistory, files.taskMetadata, files.historyItem]) {
    if (!(await pathExists(filePath))) continue;
    try {
      const fileStats = await fs.stat(filePath);
      stats.push({ filePath, size: fileStats.size, birthtime: fileStats.birthtime, mtime: fileStats.mtime });
    } catch (err) {
      logger.debug(`cline: cannot stat companion file ${filePath}`, err);
    }
  }
  return stats;
}

function messageTimestamps(data: LoadedTaskData): number[] {
  const values: number[] = [];
  for (const message of data.uiMessages) {
    if (message.ts !== undefined) values.push(message.ts);
  }
  for (const message of data.apiMessages) {
    if (message.ts !== undefined) values.push(message.ts);
  }
  if (data.taskHistoryItem?.ts !== undefined) values.push(data.taskHistoryItem.ts);
  return values;
}

// ── Session Parsing (shared) ────────────────────────────────────────────────

/**
 * Discover and parse sessions for all Cline-family extensions, optionally
 * filtering to a single source variant.
 */
async function parseSessionsForSource(filterSource?: ClineSource): Promise<UnifiedSession[]> {
  const taskEntries = await discoverTaskDirs(filterSource);
  // Per-call cache. Shared across sessions under the same `storageRoot` so
  // `taskHistory.json` is read once per discovery pass; new calls always
  // re-read so live edits to taskHistory.json take effect immediately.
  const taskHistoryCache = new Map<string, Promise<TaskHistoryReadResult>>();
  const sessions: UnifiedSession[] = [];

  for (const { taskDir, taskId, storageRoot, source } of taskEntries) {
    try {
      const storageRootKey = path.resolve(storageRoot);
      let cachedHistory = taskHistoryCache.get(storageRootKey);
      if (!cachedHistory) {
        cachedHistory = readTaskHistoryMap(taskHistoryCandidatesFromStorageRoot(storageRoot));
        taskHistoryCache.set(storageRootKey, cachedHistory);
      }

      const data = await loadTaskData(taskDir, storageRoot, taskId, await cachedHistory);
      if (data.uiMessages.length === 0 && data.apiMessages.length === 0 && !data.taskHistoryItem) continue;

      const firstUserMsg =
        extractFirstUserMessage(data.uiMessages) ||
        extractFirstApiUserMessage(data.apiMessages) ||
        data.taskHistoryItem?.task ||
        '';
      const summary = cleanSummary(firstUserMsg);
      if (!summary) continue; // Skip sessions with no real user message

      const stats = await existingCompanionStats(data.files);
      if (stats.length === 0) continue;

      // Derive timestamps: prefer message/history timestamps, fall back to file stats.
      const timestamps = messageTimestamps(data);
      const createdAt =
        timestamps.length > 0
          ? new Date(Math.min(...timestamps))
          : new Date(Math.min(...stats.map((stat) => stat.birthtime.getTime())));
      const updatedAt =
        timestamps.length > 0
          ? new Date(Math.max(...timestamps))
          : new Date(Math.max(...stats.map((stat) => stat.mtime.getTime())));
      const cwd = resolveCwd(data);
      const model = resolveModel(data);

      sessions.push({
        id: taskId,
        source,
        cwd,
        ...(cwd ? { repo: extractRepoFromCwd(cwd) } : {}),
        ...(model ? { model } : {}),
        lines: data.uiMessages.length || data.apiMessages.length,
        bytes: stats.reduce((total, stat) => total + stat.size, 0),
        createdAt,
        updatedAt,
        originalPath: stats[0].filePath,
        summary,
      });
    } catch (err) {
      logger.debug(`cline: skipping unparseable task ${taskId}`, err);
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

async function parseKiloDbSessions(): Promise<UnifiedSession[]> {
  const sessionsById = new Map<string, UnifiedSession>();

  for (const dbPath of await discoverKiloDbPaths()) {
    const handle = openKiloDb(dbPath);
    if (!handle) continue;

    const { db, close } = handle;
    try {
      const schema = inspectKiloDbSchema(db);
      if (!schema.supported) {
        warnKiloDbFidelity(dbPath, schema.warnings);
        continue;
      }

      const dbStats = await fs.stat(dbPath);
      const sessionColumns = selectColumns(schema.session, [
        'id',
        'project_id',
        'slug',
        'directory',
        'title',
        'version',
        'time_created',
        'time_updated',
      ]);
      const sortColumn = schema.session.has('time_updated') ? 'time_updated' : 'id';
      const rows = db.prepare(`SELECT ${sessionColumns} FROM session ORDER BY ${sortColumn} DESC`).all();

      for (const row of rows) {
        if (!isRecord(row)) continue;
        const id = readString(row, 'id');
        if (!id) continue;

        // Discovery uses a lightweight summary (one message-table query + at
        // most one part query for the first user message) instead of walking
        // every message and part for every session.
        const summaryRead = readKiloDbDiscoverySummary(db, schema, id);
        if (summaryRead.rowCount === 0) continue;

        const title = readString(row, 'title') ?? '';
        const slug = readString(row, 'slug') ?? '';
        const summarySource = isUnhelpfulDbTitle(title) ? summaryRead.firstUserMessage || slug : title;
        const summary = cleanSummary(summarySource || slug || summaryRead.firstUserMessage);
        if (!summary) continue;

        const projectId = readString(row, 'project_id');
        const cwd = readString(row, 'directory') || getProjectWorktree(db, schema, projectId);
        const createdAt = timestampFromValue(row.time_created) ?? summaryRead.firstTimestamp ?? dbStats.birthtime;
        const updatedAt = timestampFromValue(row.time_updated) ?? summaryRead.lastTimestamp ?? dbStats.mtime;

        const session: UnifiedSession = {
          id,
          source: 'kilo-code',
          cwd,
          repo: extractRepoFromCwd(cwd),
          lines: summaryRead.rowCount,
          bytes: dbStats.size,
          createdAt,
          updatedAt,
          originalPath: dbPath,
          summary,
          model: summaryRead.model,
        };

        const existing = sessionsById.get(id);
        if (!existing || existing.updatedAt.getTime() < session.updatedAt.getTime()) {
          sessionsById.set(id, session);
        }
      }
    } catch (err) {
      logger.debug('kilo-code: failed to parse SQLite sessions', dbPath, err);
    } finally {
      close();
    }
  }

  return Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

async function parseKiloSessionsAll(): Promise<UnifiedSession[]> {
  const sessionsById = new Map<string, UnifiedSession>();
  for (const session of await parseKiloDbSessions()) {
    sessionsById.set(session.id, session);
  }
  for (const session of await parseSessionsForSource('kilo-code')) {
    const existing = sessionsById.get(session.id);
    if (!existing || existing.updatedAt.getTime() < session.updatedAt.getTime()) {
      sessionsById.set(session.id, session);
    }
  }
  return Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// ── Context Extraction (shared) ─────────────────────────────────────────────

/**
 * Extract full session context for cross-tool handoff.
 * Shared implementation for all three Cline-family variants.
 */
async function extractContextShared(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const data = await loadTaskDataFromOriginalPath(session.originalPath, session.id);

  // Build conversation messages
  const uiConversation = buildConversation(data.uiMessages);
  const apiConversation = buildApiConversation(data.apiMessages, cfg);
  const allConversation = uiConversation.length > 0 ? uiConversation : apiConversation;
  const recentMessages = allConversation.slice(-cfg.recentMessages);

  // Extract token usage and session notes
  const sessionNotes: SessionNotes = chooseUsageNotes(data, session.source as ClineSource);
  const model = resolveModel(data);
  if (model) sessionNotes.model = model;

  // Extract reasoning highlights
  const uiReasoning = extractReasoning(data.uiMessages, cfg.thinking?.maxHighlights ?? 5);
  const reasoning =
    uiReasoning.length > 0 ? uiReasoning : extractApiReasoning(data.apiMessages, cfg.thinking?.maxHighlights ?? 5);
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  // Extract pending tasks. Three layers in order:
  //   1. UI events (`completion_result` / `text`) — preserves the exact
  //      assistant statement Cline rendered to the user.
  //   2. UI-conversation tail — covers tasks where the assistant text is
  //      structured but not on a `completion_result` event.
  //   3. API-conversation tail — covers tasks where ui_messages.json is
  //      thin or malformed but api_conversation_history.json is intact.
  // Each layer is tried only when the previous one returned no hits.
  const maxPendingTasks = cfg.pendingTasks?.maxTasks ?? 5;
  const pendingTasksFromUi = extractPendingTasks(data.uiMessages, maxPendingTasks);
  const pendingTasksFromAllConversation =
    pendingTasksFromUi.length > 0
      ? pendingTasksFromUi
      : extractPendingTasksFromConversation(allConversation, maxPendingTasks);
  const pendingTasks =
    pendingTasksFromAllConversation.length > 0 || allConversation === apiConversation
      ? pendingTasksFromAllConversation
      : extractPendingTasksFromConversation(apiConversation, maxPendingTasks);

  const toolData = extractToolData(data, cfg);
  const sourceMetadata = buildSourceMetadata(data);
  if (sourceMetadata) sessionNotes.sourceMetadata = sourceMetadata;
  const fidelityWarnings = uniqueStrings([...data.fidelityWarnings, ...toolData.fidelityWarnings]);
  if (fidelityWarnings.length > 0) {
    sessionNotes.fidelityWarnings = fidelityWarnings;
  }
  const cwd = resolveCwd(data) || session.cwd;
  const sessionWithMetadata: UnifiedSession = {
    ...session,
    ...(cwd ? { cwd, repo: session.repo || extractRepoFromCwd(cwd) } : {}),
    ...(model ? { model } : {}),
  };

  const markdown = generateHandoffMarkdown(
    sessionWithMetadata,
    recentMessages,
    toolData.filesModified,
    pendingTasks,
    toolData.summaries,
    sessionNotes,
    cfg,
  );

  return {
    session: sessionWithMetadata,
    recentMessages,
    filesModified: toolData.filesModified,
    pendingTasks,
    toolSummaries: toolData.summaries,
    sessionNotes,
    markdown,
  };
}

function isTaskCompanionPath(filePath: string): boolean {
  return path.basename(path.dirname(path.dirname(filePath))) === 'tasks';
}

function isKiloDbSession(session: UnifiedSession): boolean {
  return session.source === 'kilo-code' && !isTaskCompanionPath(session.originalPath);
}

function emptyKiloDbContext(session: UnifiedSession, cfg: VerbosityConfig, fidelityWarnings: string[]): SessionContext {
  const sessionNotes: SessionNotes = {
    rawAccess: { kind: 'sqlite', path: session.originalPath },
    sourceMetadata: { storage: 'sqlite', dbPath: session.originalPath },
    fidelityWarnings,
  };
  const markdown = generateHandoffMarkdown(session, [], [], [], [], sessionNotes, cfg);

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

function readKiloSessionRow(
  db: SqliteDatabase,
  schema: KiloDbSchema,
  sessionId: string,
): Record<string, unknown> | null {
  const sessionColumns = selectColumns(schema.session, ['id', 'project_id', 'slug', 'directory', 'title', 'version']);
  try {
    const row = db.prepare(`SELECT ${sessionColumns} FROM session WHERE id = ?`).get(sessionId);
    return isRecord(row) ? row : null;
  } catch (err) {
    logger.debug('kilo-code: failed to read SQLite session metadata', sessionId, err);
    return null;
  }
}

async function extractKiloDbContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const handle = openKiloDb(session.originalPath);
  if (!handle) {
    return emptyKiloDbContext(session, cfg, [`Kilo SQLite database could not be opened: ${session.originalPath}`]);
  }

  const { db, close } = handle;
  try {
    const schema = inspectKiloDbSchema(db);
    if (!schema.supported) {
      warnKiloDbFidelity(session.originalPath, schema.warnings);
      return emptyKiloDbContext(session, cfg, schema.warnings);
    }

    const messageRead = readKiloDbMessagesFromHandle(db, schema, session.id, cfg.thinking?.maxHighlights ?? 5);
    const sessionRow = readKiloSessionRow(db, schema, session.id);
    const warnings =
      messageRead.rowCount === 0 ? [`Kilo SQLite session "${session.id}" has no readable message rows.`] : [];

    const sessionNotes: SessionNotes = {
      ...messageRead.notes,
      rawAccess: { kind: 'sqlite', path: session.originalPath },
      sourceMetadata: {
        ...(messageRead.notes.sourceMetadata ?? {}),
        ...(sessionRow ? sessionSourceMetadata(sessionRow, session.originalPath) : {}),
        storage: 'sqlite',
        dbPath: session.originalPath,
      },
      ...(warnings.length > 0 ? { fidelityWarnings: warnings } : {}),
    };

    const recentMessages = messageRead.messages.slice(-cfg.recentMessages);
    const enrichedSession = sessionNotes.model ? { ...session, model: sessionNotes.model } : session;
    const markdown = generateHandoffMarkdown(enrichedSession, recentMessages, [], [], [], sessionNotes, cfg);

    return {
      session: enrichedSession,
      recentMessages,
      filesModified: [],
      pendingTasks: [],
      toolSummaries: [],
      sessionNotes,
      markdown,
    };
  } catch (err) {
    logger.debug('kilo-code: failed to extract SQLite context', session.originalPath, session.id, err);
    return emptyKiloDbContext(session, cfg, [
      `Kilo SQLite session "${session.id}" could not be extracted without losing fidelity.`,
    ]);
  } finally {
    close();
  }
}

// ── Public API: Cline ───────────────────────────────────────────────────────

/** Discover sessions for Cline only */
export async function parseClineSessions(): Promise<UnifiedSession[]> {
  return parseSessionsForSource('cline');
}

/** Extract context from a Cline session */
export async function extractClineContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  return extractContextShared(session, config);
}

// ── Public API: Roo Code ────────────────────────────────────────────────────

/** Discover sessions for Roo Code only */
export async function parseRooCodeSessions(): Promise<UnifiedSession[]> {
  return parseSessionsForSource('roo-code');
}

/** Extract context from a Roo Code session (delegates to shared implementation) */
export async function extractRooCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  return extractContextShared(session, config);
}

// ── Public API: Kilo Code ───────────────────────────────────────────────────

/** Discover sessions for Kilo Code only */
export async function parseKiloCodeSessions(): Promise<UnifiedSession[]> {
  return parseKiloSessionsAll();
}

/** Extract context from a Kilo Code session (delegates to shared implementation) */
export async function extractKiloCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  if (isKiloDbSession(session)) return extractKiloDbContext(session, config);
  return extractContextShared(session, config);
}

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  StructuredToolSample,
  UnifiedSession,
} from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
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

// ── Extension Configs ───────────────────────────────────────────────────────

/**
 * All Cline-family extensions share the same ui_messages.json format.
 * Each entry maps a VS Code extension ID to the source label used in UnifiedSession.
 */
const TASK_FILE_NAMES = {
  apiConversationHistory: 'api_conversation_history.json',
  uiMessages: 'ui_messages.json',
  taskMetadata: 'task_metadata.json',
  historyItem: 'history_item.json',
  historyIndex: '_index.json',
} as const;

const CLINE_EXTENSIONS = [
  {
    id: 'saoudrizwan.claude-dev',
    source: 'cline',
    customStorageSettingKeys: ['cline.customStoragePath'],
    customStorageEnvKeys: ['CLINE_STORAGE_PATH', 'CONTINUES_CLINE_STORAGE_PATH'],
  },
  {
    // Roo's current VS Code manifest is publisher RooVeterinaryInc + name roo-cline,
    // which VS Code stores lowercased as rooveterinaryinc.roo-cline.
    id: 'rooveterinaryinc.roo-cline',
    source: 'roo-code',
    customStorageSettingKeys: ['roo-cline.customStoragePath'],
    customStorageEnvKeys: ['ROO_CODE_STORAGE_PATH', 'ROO_CLINE_STORAGE_PATH', 'CONTINUES_ROO_CODE_STORAGE_PATH'],
  },
  {
    // Compatibility-only path kept for users who still have older local data.
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
  partial?: boolean;
}

interface ApiRawMessage {
  role: 'user' | 'assistant' | 'system';
  content: unknown;
  ts?: number;
  isSummary?: boolean;
  reasoning_content?: string;
  text?: string;
  summary?: unknown;
}

interface ToolInvocation {
  id?: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
}

interface StorageProfile {
  globalStorageBase: string;
  settingsPath: string;
}

interface TaskEntry {
  taskDir: string;
  taskId: string;
  source: ClineSource;
  tasksRoot: string;
}

interface TaskSidecars {
  uiMessages: ClineRawMessage[];
  apiMessages: ApiRawMessage[];
  taskMetadata?: Record<string, unknown>;
  historyItem?: Record<string, unknown>;
  warnings: string[];
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

// ── Path Discovery ──────────────────────────────────────────────────────────

/**
 * Build candidate globalStorage base directories for local and remote extension
 * hosts. Remote VS Code servers use ~/.vscode-server.../data/User/globalStorage;
 * Cursor follows the same server layout when its remote host data exists.
 */
function getStorageProfiles(): StorageProfile[] {
  const home = homeDir();
  const profiles: StorageProfile[] = [];
  const addProfile = (globalStorageBase: string) => {
    profiles.push({
      globalStorageBase,
      settingsPath: path.join(path.dirname(globalStorageBase), 'settings.json'),
    });
  };

  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    addProfile(path.join(appSupport, 'Code', 'User', 'globalStorage'));
    addProfile(path.join(appSupport, 'Code - Insiders', 'User', 'globalStorage'));
    addProfile(path.join(appSupport, 'Cursor', 'User', 'globalStorage'));
    addProfile(path.join(appSupport, 'Windsurf', 'User', 'globalStorage'));
  } else if (process.platform === 'linux') {
    addProfile(path.join(home, '.config', 'Code', 'User', 'globalStorage'));
    addProfile(path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage'));
    addProfile(path.join(home, '.config', 'Cursor', 'User', 'globalStorage'));
    addProfile(path.join(home, '.config', 'Windsurf', 'User', 'globalStorage'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    addProfile(path.join(appData, 'Code', 'User', 'globalStorage'));
    addProfile(path.join(appData, 'Code - Insiders', 'User', 'globalStorage'));
    addProfile(path.join(appData, 'Cursor', 'User', 'globalStorage'));
    addProfile(path.join(appData, 'Windsurf', 'User', 'globalStorage'));
  }

  addProfile(path.join(home, '.vscode-server', 'data', 'User', 'globalStorage'));
  addProfile(path.join(home, '.vscode-server-insiders', 'data', 'User', 'globalStorage'));
  addProfile(path.join(home, '.cursor-server', 'data', 'User', 'globalStorage'));
  addProfile(path.join(home, '.cursor-server-insiders', 'data', 'User', 'globalStorage'));

  return profiles.filter(
    (profile, index) =>
      profiles.findIndex((candidate) => candidate.globalStorageBase === profile.globalStorageBase) === index,
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
    const content = await fs.readFile(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(stripJsonComments(content));
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    logger.debug(`cline: cannot read settings ${settingsPath}`, err);
    return {};
  }
}

async function discoverCustomStorageRoots(ext: ClineExtension, profiles: StorageProfile[]): Promise<string[]> {
  const roots = new Set<string>();
  const addRoot = (value: string) => {
    const expanded = expandHomePath(value);
    if (path.isAbsolute(expanded)) roots.add(expanded);
  };

  for (const envKey of ext.customStorageEnvKeys) {
    const value = process.env[envKey];
    if (value) addRoot(value);
  }

  for (const profile of profiles) {
    const settings = await readSettings(profile.settingsPath);
    for (const settingKey of ext.customStorageSettingKeys) {
      const value = readString(settings, settingKey);
      if (value) addRoot(value);
    }
  }

  return Array.from(roots);
}

async function discoverTaskDirsInRoot(
  tasksRoot: string,
  source: ClineSource,
): Promise<Array<{ taskDir: string; taskId: string; source: ClineSource; tasksRoot: string }>> {
  const results: Array<{ taskDir: string; taskId: string; source: ClineSource; tasksRoot: string }> = [];
  if (!(await pathExists(tasksRoot))) return results;

  try {
    const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskDir = path.join(tasksRoot, entry.name);
      if (await hasRecognizedTaskFile(taskDir)) {
        results.push({ taskDir, taskId: entry.name, source, tasksRoot });
      }
    }
  } catch (err) {
    logger.debug(`cline: cannot read tasks dir ${tasksRoot}`, err);
  }

  return results;
}

async function hasRecognizedTaskFile(taskDir: string): Promise<boolean> {
  return (
    (await pathExists(path.join(taskDir, TASK_FILE_NAMES.uiMessages))) ||
    (await pathExists(path.join(taskDir, TASK_FILE_NAMES.apiConversationHistory))) ||
    (await pathExists(path.join(taskDir, TASK_FILE_NAMES.historyItem)))
  );
}

/**
 * Discover all task directories for a given extension across all IDE locations.
 * Returns tuples of (task-id directory path, extension source label).
 */
async function discoverTaskDirs(): Promise<TaskEntry[]> {
  const profiles = getStorageProfiles();
  const results: TaskEntry[] = [];

  for (const profile of profiles) {
    if (!(await pathExists(profile.globalStorageBase))) continue;

    for (const ext of CLINE_EXTENSIONS) {
      const tasksRoot = path.join(profile.globalStorageBase, ext.id, 'tasks');
      results.push(...(await discoverTaskDirsInRoot(tasksRoot, ext.source)));
    }
  }

  for (const ext of CLINE_EXTENSIONS) {
    for (const customRoot of await discoverCustomStorageRoots(ext, profiles)) {
      results.push(...(await discoverTaskDirsInRoot(path.join(customRoot, 'tasks'), ext.source)));
    }
  }

  return results.filter(
    (entry, index) =>
      results.findIndex((candidate) => candidate.source === entry.source && candidate.taskDir === entry.taskDir) ===
      index,
  );
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
    partial: readBoolean(value, 'partial'),
  };
}

function normalizeApiMessage(value: unknown): ApiRawMessage | null {
  if (!isRecord(value)) return null;
  const role = readString(value, 'role');
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;

  return {
    role,
    content: value.content,
    ts: readNumber(value, 'ts'),
    isSummary: readBoolean(value, 'isSummary'),
    reasoning_content: readString(value, 'reasoning_content'),
    text: readString(value, 'text'),
    summary: value.summary,
  };
}

async function readJsonValue(filePath: string, warnings?: string[], label?: string): Promise<unknown | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    if (!content.trim()) {
      warnings?.push(`${label ?? path.basename(filePath)} was empty; the task may still be writing or locked.`);
      return undefined;
    }
    return JSON.parse(content);
  } catch (err) {
    if (warnings) {
      warnings.push(
        `${label ?? path.basename(filePath)} could not be read as complete JSON; Roo/Cline may still be writing or locking it.`,
      );
    }
    logger.debug(`cline: failed to parse ${filePath}`, err);
    return undefined;
  }
}

/** Read and parse ui_messages.json, returning an empty array on failure */
async function readUiMessages(filePath: string, warnings?: string[]): Promise<ClineRawMessage[]> {
  const parsed = await readJsonValue(filePath, warnings, TASK_FILE_NAMES.uiMessages);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeRawMessage).filter((msg): msg is ClineRawMessage => msg !== null);
}

async function readApiMessages(filePath: string, warnings?: string[]): Promise<ApiRawMessage[]> {
  const parsed = await readJsonValue(filePath, warnings, TASK_FILE_NAMES.apiConversationHistory);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeApiMessage).filter((msg): msg is ApiRawMessage => msg !== null);
}

async function readRecordFile(
  filePath: string,
  warnings?: string[],
  label?: string,
): Promise<Record<string, unknown> | undefined> {
  const parsed = await readJsonValue(filePath, warnings, label);
  return isRecord(parsed) ? parsed : undefined;
}

function taskDirFromOriginalPath(originalPath: string): string {
  if (path.basename(originalPath).endsWith('.json')) return path.dirname(originalPath);
  return originalPath;
}

async function readHistoryItem(taskDir: string, taskId: string, tasksRoot: string, warnings?: string[]) {
  const perTaskPath = path.join(taskDir, TASK_FILE_NAMES.historyItem);
  const perTask = (await pathExists(perTaskPath))
    ? await readRecordFile(perTaskPath, warnings, TASK_FILE_NAMES.historyItem)
    : undefined;
  if (perTask) return perTask;

  const indexPath = path.join(tasksRoot, TASK_FILE_NAMES.historyIndex);
  const index = (await pathExists(indexPath))
    ? await readRecordFile(indexPath, warnings, TASK_FILE_NAMES.historyIndex)
    : undefined;
  const entries = index?.entries;
  if (!Array.isArray(entries)) return undefined;

  const match = entries.find((entry) => isRecord(entry) && readString(entry, 'id') === taskId);
  return isRecord(match) ? match : undefined;
}

async function readTaskSidecars(taskDir: string, taskId: string, warnings: string[] = []): Promise<TaskSidecars> {
  const tasksRoot = path.dirname(taskDir);
  const uiPath = path.join(taskDir, TASK_FILE_NAMES.uiMessages);
  const apiPath = path.join(taskDir, TASK_FILE_NAMES.apiConversationHistory);
  const metadataPath = path.join(taskDir, TASK_FILE_NAMES.taskMetadata);

  const uiMessages = (await pathExists(uiPath)) ? await readUiMessages(uiPath) : [];
  const apiMessages = (await pathExists(apiPath)) ? await readApiMessages(apiPath, warnings) : [];
  const taskMetadata = (await pathExists(metadataPath))
    ? await readRecordFile(metadataPath, warnings, TASK_FILE_NAMES.taskMetadata)
    : undefined;
  const historyItem = await readHistoryItem(taskDir, taskId, tasksRoot, warnings);

  return { uiMessages, apiMessages, taskMetadata, historyItem, warnings };
}

function messageText(msg: ClineRawMessage): string | undefined {
  return msg.say === 'reasoning' ? (msg.reasoning ?? msg.text) : msg.text;
}

function isApiRequestMetadata(msg: ClineRawMessage): boolean {
  return msg.type === 'say' && (msg.say === 'api_req_started' || msg.say === 'api_req_finished');
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
 * Used for session summary.
 */
function extractFirstUserMessage(messages: ClineRawMessage[]): string {
  for (const msg of buildConversation(messages)) {
    if (msg.role === 'user' && msg.content.length > 0) {
      return msg.content;
    }
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

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      const type = readString(block, 'type');
      if (type === 'text') return readString(block, 'text') ?? '';
      if (type === 'thinking' || type === 'reasoning')
        return readString(block, 'thinking') ?? readString(block, 'text') ?? '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function buildApiConversation(messages: ApiRawMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];

  for (const msg of messages) {
    if (msg.isSummary) continue;
    const content = textFromContent(msg.content).trim();
    if (!content) continue;
    result.push({ role: msg.role, content, timestamp: msg.ts ? new Date(msg.ts) : undefined });
  }

  return result;
}

function extractFirstApiUserMessage(messages: ApiRawMessage[]): string {
  for (const msg of buildApiConversation(messages)) {
    if (msg.role === 'user' && msg.content.length > 0) return msg.content;
  }
  return '';
}

function extractReasoningFromApi(messages: ApiRawMessage[], max: number): string[] {
  const highlights: string[] = [];

  for (const msg of messages) {
    if (highlights.length >= max) break;
    const candidates: string[] = [];
    if (msg.reasoning_content) candidates.push(msg.reasoning_content);
    if (msg.text && msg.role === 'assistant') candidates.push(msg.text);
    if (Array.isArray(msg.summary)) {
      for (const item of msg.summary) {
        if (isRecord(item)) {
          const text = readString(item, 'text');
          if (text) candidates.push(text);
        }
      }
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!isRecord(block)) continue;
        const type = readString(block, 'type');
        if (type !== 'thinking' && type !== 'reasoning') continue;
        const text = readString(block, 'thinking') ?? readString(block, 'text');
        if (text) candidates.push(text);
      }
    }

    for (const candidate of candidates) {
      if (highlights.length >= max) break;
      const trimmed = candidate.trim();
      if (trimmed.length >= 10) highlights.push(truncate(trimmed, 200));
    }
  }

  return highlights;
}

function contentPreview(content: unknown): string | undefined {
  const text = textFromContent(content).trim();
  return text ? truncate(text, 200) : undefined;
}

function inputRecord(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined;
}

function inputString(input: unknown, keys: string[]): string | undefined {
  const record = inputRecord(input);
  if (!record) return undefined;

  for (const key of keys) {
    const value = readString(record, key);
    if (value) return value;
  }

  return undefined;
}

function stringifiedInput(input: unknown): string {
  if (!isRecord(input)) return typeof input === 'string' ? truncate(input, 160) : '';

  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 4)
    .map(([key, value]) => {
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}: ${truncate(rendered ?? '', 80)}`;
    });

  return entries.join(', ');
}

function toolFilePath(input: unknown): string | undefined {
  return inputString(input, ['path', 'filePath', 'file_path', 'relativePath', 'relative_path']);
}

function isWriteToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized.includes('write') ||
    normalized.includes('replace') ||
    normalized.includes('edit') ||
    normalized.includes('diff') ||
    normalized.includes('patch') ||
    normalized.includes('insert')
  );
}

function structuredResult(result?: string): string | undefined {
  return result ? truncate(result, 200) : undefined;
}

function toolSampleForInvocation(invocation: ToolInvocation): {
  category: string;
  summary: string;
  data?: StructuredToolSample;
  filePath?: string;
  isWrite?: boolean;
  isError?: boolean;
} {
  const name = invocation.name;
  const normalized = name.toLowerCase();
  const result = structuredResult(invocation.result);
  const filePath = toolFilePath(invocation.input);
  const args = stringifiedInput(invocation.input);
  const isError = invocation.isError === true;

  if (normalized === 'execute_command' || normalized === 'run_command' || normalized === 'shell') {
    const command = inputString(invocation.input, ['command', 'cmd']) ?? args;
    return {
      category: 'shell',
      summary: shellSummary(command, result),
      data: {
        category: 'shell',
        command,
        ...(result ? { stdoutTail: result } : {}),
        ...(isError ? { errored: true } : {}),
      },
      isError,
    };
  }

  if (normalized === 'read_file' || normalized === 'read_file_tool') {
    const target = filePath ?? args;
    return {
      category: 'read',
      summary: withResult(fileSummary('read', target), result),
      data: { category: 'read', filePath: target },
      filePath: target,
      isError,
    };
  }

  if (isWriteToolName(normalized)) {
    const target = filePath ?? args;
    const op = normalized.includes('write') ? 'write' : 'edit';
    return {
      category: op,
      summary: withResult(fileSummary(op, target), result),
      data: { category: op, filePath: target },
      filePath: target,
      isWrite: !!target,
      isError,
    };
  }

  if (normalized === 'search_files' || normalized === 'grep_search') {
    const pattern = inputString(invocation.input, ['regex', 'pattern', 'query']) ?? args;
    const target = inputString(invocation.input, ['path', 'directory', 'targetPath']);
    return {
      category: 'grep',
      summary: withResult(grepSummary(pattern, target), result),
      data: { category: 'grep', pattern, ...(target ? { targetPath: target } : {}) },
      isError,
    };
  }

  if (normalized === 'list_files' || normalized === 'glob') {
    const pattern = inputString(invocation.input, ['path', 'pattern']) ?? args;
    return {
      category: 'glob',
      summary: withResult(globSummary(pattern), result),
      data: { category: 'glob', pattern },
      isError,
    };
  }

  if (normalized === 'ask_followup_question') {
    const question = inputString(invocation.input, ['question']) ?? args;
    return {
      category: 'AskUserQuestion',
      summary: `ask "${truncate(question, 80)}"`,
      data: { category: 'ask', question: truncate(question, 80) },
      isError,
    };
  }

  if (normalized === 'use_mcp_tool') {
    const serverName = inputString(invocation.input, ['server_name', 'serverName']) ?? 'mcp';
    const toolName = inputString(invocation.input, ['tool_name', 'toolName']) ?? name;
    const fullName = `${serverName}.${toolName}`;
    return {
      category: 'mcp',
      summary: mcpSummary(fullName, args, result),
      data: { category: 'mcp', toolName: fullName, ...(args ? { params: args } : {}), ...(result ? { result } : {}) },
      isError,
    };
  }

  return {
    category: name,
    summary: withResult(`${name}(${args})`, result),
    data: { category: 'mcp', toolName: name, ...(args ? { params: args } : {}), ...(result ? { result } : {}) },
    filePath,
    isWrite: filePath ? isWriteToolName(normalized) : false,
    isError,
  };
}

function collectToolInvocationsFromApi(messages: ApiRawMessage[]): ToolInvocation[] {
  const invocations: ToolInvocation[] = [];
  const byId = new Map<string, ToolInvocation>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (!isRecord(block)) continue;
      const type = readString(block, 'type');

      if (type === 'tool_use') {
        const name = readString(block, 'name');
        if (!name) continue;
        const id = readString(block, 'id');
        const invocation: ToolInvocation = { id, name, input: block.input };
        invocations.push(invocation);
        if (id) byId.set(id, invocation);
      } else if (type === 'tool_result') {
        const id = readString(block, 'tool_use_id');
        const invocation = id ? byId.get(id) : undefined;
        if (!invocation) continue;
        invocation.result = contentPreview(block.content);
        invocation.isError = readBoolean(block, 'is_error') ?? false;
      }
    }
  }

  return invocations;
}

function addApiToolSummaries(messages: ApiRawMessage[], collector: SummaryCollector): void {
  for (const invocation of collectToolInvocationsFromApi(messages)) {
    const sample = toolSampleForInvocation(invocation);
    collector.add(sample.category, sample.summary, {
      data: sample.data,
      filePath: sample.filePath,
      isWrite: sample.isWrite,
      isError: sample.isError,
    });
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
    const filePath = toolFilePath(parsed);
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

function addMetadataFiles(taskMetadata: Record<string, unknown> | undefined, collector: SummaryCollector): void {
  const files = taskMetadata?.files_in_context;
  if (!Array.isArray(files)) return;

  for (const item of files) {
    if (!isRecord(item)) continue;
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

// ── Token / Cost Extraction ─────────────────────────────────────────────────

/**
 * Aggregate token usage and cost from api_req_started events.
 * Each event's text field contains a JSON object with token counts.
 */
function extractTokenUsage(messages: ClineRawMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheWrites = 0;
  let totalCacheReads = 0;
  let found = false;

  for (const msg of messages) {
    if (msg.type !== 'say' || (msg.say !== 'api_req_started' && msg.say !== 'api_req_finished')) continue;
    if (!msg.text) continue;

    try {
      const parsed: unknown = JSON.parse(msg.text);
      if (!isRecord(parsed)) continue;

      const tokensIn = readNumber(parsed, 'tokensIn') ?? readNumber(parsed, 'totalTokensIn');
      if (tokensIn !== undefined) {
        totalIn += tokensIn;
        found = true;
      }
      const tokensOut = readNumber(parsed, 'tokensOut') ?? readNumber(parsed, 'totalTokensOut');
      if (tokensOut !== undefined) {
        totalOut += tokensOut;
        found = true;
      }
      const cacheWrites = readNumber(parsed, 'cacheWrites') ?? readNumber(parsed, 'totalCacheWrites');
      if (cacheWrites !== undefined) {
        totalCacheWrites += cacheWrites;
        found = true;
      }
      const cacheReads = readNumber(parsed, 'cacheReads') ?? readNumber(parsed, 'totalCacheReads');
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

function applyHistoryItemNotes(notes: SessionNotes, historyItem: Record<string, unknown> | undefined): void {
  if (!historyItem) return;

  const tokensIn = readNumber(historyItem, 'tokensIn');
  const tokensOut = readNumber(historyItem, 'tokensOut');
  if (tokensIn !== undefined || tokensOut !== undefined) {
    notes.tokenUsage = { input: tokensIn ?? 0, output: tokensOut ?? 0 };
  }

  const cacheWrites = readNumber(historyItem, 'cacheWrites');
  const cacheReads = readNumber(historyItem, 'cacheReads');
  if (cacheWrites !== undefined || cacheReads !== undefined) {
    notes.cacheTokens = { creation: cacheWrites ?? 0, read: cacheReads ?? 0 };
  }
}

function extractModelFromTaskMetadata(taskMetadata: Record<string, unknown> | undefined): string | undefined {
  const modelUsage = taskMetadata?.model_usage;
  if (!Array.isArray(modelUsage)) return undefined;

  for (let i = modelUsage.length - 1; i >= 0; i--) {
    const item = modelUsage[i];
    if (!isRecord(item)) continue;
    const model = readString(item, 'model_id');
    if (model) return model;
  }

  return undefined;
}

function buildSourceMetadata(sidecars: TaskSidecars): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};

  if (sidecars.apiMessages.length > 0) metadata.apiConversationMessages = sidecars.apiMessages.length;
  if (sidecars.taskMetadata) {
    const files = sidecars.taskMetadata.files_in_context;
    const modelUsage = sidecars.taskMetadata.model_usage;
    metadata.taskMetadata = {
      ...(Array.isArray(files) ? { filesInContext: files.length } : {}),
      ...(Array.isArray(modelUsage) ? { modelUsage: modelUsage.length } : {}),
    };
  }
  if (sidecars.historyItem) {
    metadata.historyItem = {
      ...(readString(sidecars.historyItem, 'status') ? { status: readString(sidecars.historyItem, 'status') } : {}),
      ...(readString(sidecars.historyItem, 'mode') ? { mode: readString(sidecars.historyItem, 'mode') } : {}),
      ...(readString(sidecars.historyItem, 'apiConfigName')
        ? { apiConfigName: readString(sidecars.historyItem, 'apiConfigName') }
        : {}),
    };
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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

function firstTimestamp(uiMessages: ClineRawMessage[], apiMessages: ApiRawMessage[]): number | undefined {
  const timestamps = [
    ...uiMessages.map((msg) => msg.ts).filter((ts): ts is number => ts !== undefined),
    ...apiMessages.map((msg) => msg.ts).filter((ts): ts is number => ts !== undefined),
  ];
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function lastTimestamp(
  uiMessages: ClineRawMessage[],
  apiMessages: ApiRawMessage[],
  historyItem: Record<string, unknown> | undefined,
): number | undefined {
  const historyTs = historyItem ? readNumber(historyItem, 'ts') : undefined;
  const timestamps = [
    ...uiMessages.map((msg) => msg.ts).filter((ts): ts is number => ts !== undefined),
    ...apiMessages.map((msg) => msg.ts).filter((ts): ts is number => ts !== undefined),
    ...(historyTs !== undefined ? [historyTs] : []),
  ];
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

async function taskBytes(taskDir: string): Promise<number> {
  let total = 0;
  for (const fileName of [
    TASK_FILE_NAMES.uiMessages,
    TASK_FILE_NAMES.apiConversationHistory,
    TASK_FILE_NAMES.taskMetadata,
    TASK_FILE_NAMES.historyItem,
  ]) {
    const filePath = path.join(taskDir, fileName);
    if (!(await pathExists(filePath))) continue;
    try {
      total += (await fs.stat(filePath)).size;
    } catch (err) {
      logger.debug(`cline: cannot stat ${filePath}`, err);
    }
  }
  return total;
}

async function originalTaskPath(taskDir: string): Promise<string> {
  for (const fileName of [
    TASK_FILE_NAMES.uiMessages,
    TASK_FILE_NAMES.historyItem,
    TASK_FILE_NAMES.apiConversationHistory,
  ]) {
    const filePath = path.join(taskDir, fileName);
    if (await pathExists(filePath)) return filePath;
  }
  return taskDir;
}

// ── Session Parsing (shared) ────────────────────────────────────────────────

/**
 * Discover and parse sessions for all Cline-family extensions, optionally
 * filtering to a single source variant.
 */
async function parseSessionsForSource(filterSource?: ClineSource): Promise<UnifiedSession[]> {
  const taskEntries = await discoverTaskDirs();
  const sessions: UnifiedSession[] = [];

  for (const { taskDir, taskId, source } of taskEntries) {
    if (filterSource && source !== filterSource) continue;

    try {
      const sidecars = await readTaskSidecars(taskDir, taskId);
      const summary = cleanSummary(
        readString(sidecars.historyItem ?? {}, 'task') ||
          readString(sidecars.taskMetadata ?? {}, 'task') ||
          extractFirstUserMessage(sidecars.uiMessages) ||
          extractFirstApiUserMessage(sidecars.apiMessages),
      );
      if (!summary) continue; // Skip sessions with no real user message

      // Derive timestamps: prefer message timestamps, fall back to file stats
      const chosenPath = await originalTaskPath(taskDir);
      const fileStats = await fs.stat(chosenPath);
      const firstTs = firstTimestamp(sidecars.uiMessages, sidecars.apiMessages);
      const lastTs = lastTimestamp(sidecars.uiMessages, sidecars.apiMessages, sidecars.historyItem);
      const model = extractModelFromTaskMetadata(sidecars.taskMetadata);
      const cwd = sidecars.historyItem ? readString(sidecars.historyItem, 'workspace') : undefined;

      sessions.push({
        id: taskId,
        source,
        cwd: cwd ?? '',
        lines: sidecars.uiMessages.length + sidecars.apiMessages.length,
        bytes: (await taskBytes(taskDir)) || fileStats.size,
        createdAt: firstTs ? new Date(firstTs) : fileStats.birthtime,
        updatedAt: lastTs ? new Date(lastTs) : fileStats.mtime,
        originalPath: chosenPath,
        summary,
        ...(model ? { model } : {}),
      });
    } catch (err) {
      logger.debug(`cline: skipping unparseable task ${taskId}`, err);
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

// ── Context Extraction (shared) ─────────────────────────────────────────────

/**
 * Extract full session context for cross-tool handoff.
 * Shared implementation for all three Cline-family variants.
 */
async function extractContextShared(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const taskDir = taskDirFromOriginalPath(session.originalPath);
  const warnings: string[] = [];
  const sidecars = await readTaskSidecars(taskDir, session.id, warnings);
  const messages = sidecars.uiMessages;

  // Build conversation messages
  const uiConversation = buildConversation(messages);
  const apiConversation = buildApiConversation(sidecars.apiMessages);
  const allConversation = uiConversation.length > 0 ? uiConversation : apiConversation;
  const recentMessages = allConversation.slice(-cfg.recentMessages);

  // Extract token usage and session notes
  const sessionNotes: SessionNotes = extractTokenUsage(messages);
  applyHistoryItemNotes(sessionNotes, sidecars.historyItem);

  const model = extractModelFromTaskMetadata(sidecars.taskMetadata);
  if (model) sessionNotes.model = model;

  // Extract reasoning highlights
  const reasoning = [
    ...extractReasoning(messages, cfg.thinking?.maxHighlights ?? 5),
    ...extractReasoningFromApi(sidecars.apiMessages, cfg.thinking?.maxHighlights ?? 5),
  ].slice(0, cfg.thinking?.maxHighlights ?? 5);
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  // Extract pending tasks
  const pendingTasks = extractPendingTasks(messages, cfg.pendingTasks?.maxTasks ?? 5);

  const collector = new SummaryCollector(cfg);
  addApiToolSummaries(sidecars.apiMessages, collector);
  const hasUiOnlyToolSummaries = addUiToolSummaries(messages, collector);
  addMetadataFiles(sidecars.taskMetadata, collector);
  if (hasUiOnlyToolSummaries && sidecars.apiMessages.length === 0) {
    warnings.push('UI-only tool records are approval/status records; tool results may be incomplete.');
  }

  const sourceMetadata = buildSourceMetadata(sidecars);
  if (sourceMetadata) sessionNotes.sourceMetadata = sourceMetadata;
  if (warnings.length > 0) sessionNotes.fidelityWarnings = uniqueStrings(warnings);

  const toolSummaries = collector.getSummaries();
  const filesModified = collector.getFilesModified();
  const enrichedSession = {
    ...session,
    ...(sidecars.historyItem && readString(sidecars.historyItem, 'workspace')
      ? { cwd: readString(sidecars.historyItem, 'workspace') ?? session.cwd }
      : {}),
    ...(sessionNotes.model ? { model: sessionNotes.model } : {}),
  };

  const markdown = generateHandoffMarkdown(
    enrichedSession,
    recentMessages,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    cfg,
  );

  return {
    session: enrichedSession,
    recentMessages,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
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
  return parseSessionsForSource('kilo-code');
}

/** Extract context from a Kilo Code session (delegates to shared implementation) */
export async function extractKiloCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  return extractContextShared(session, config);
}

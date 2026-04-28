import * as fs from 'node:fs/promises';
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

// ── Extension Configs ───────────────────────────────────────────────────────

/**
 * All Cline-family extensions share the same ui_messages.json format.
 * Each entry maps a VS Code extension ID to the source label used in UnifiedSession.
 */
const CLINE_EXTENSIONS = [
  { id: 'saoudrizwan.claude-dev', source: 'cline' },
  { id: 'rooveterinaryinc.roo-cline', source: 'roo-code' },
  { id: 'roo-code.roo-cline', source: 'roo-code' },
  { id: 'kilocode.kilo-code', source: 'kilo-code' },
] as const;

type ClineSource = (typeof CLINE_EXTENSIONS)[number]['source'];

const UI_MESSAGES_FILE = 'ui_messages.json';
const API_CONVERSATION_HISTORY_FILE = 'api_conversation_history.json';
const TASK_METADATA_FILE = 'task_metadata.json';
const TASK_HISTORY_FILE = 'taskHistory.json';
const TASK_SIGNAL_FILES = [UI_MESSAGES_FILE, API_CONVERSATION_HISTORY_FILE, TASK_METADATA_FILE] as const;

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
  modelId?: string;
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
  taskHistoryCandidates: string[];
}

interface LoadedTaskData {
  files: TaskFiles;
  uiMessages: ClineRawMessage[];
  apiMessages: ClineApiMessage[];
  taskMetadata?: ClineTaskMetadata;
  taskHistoryItem?: ClineTaskHistoryItem;
}

interface ToolResultEntry {
  text: string;
  isError: boolean;
}

interface ToolData {
  summaries: ToolUsageSummary[];
  filesModified: string[];
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

  return bases;
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
    results.push(filePath);
  }
  return results;
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
    cwdOnTaskInitialization: readString(value, 'cwdOnTaskInitialization'),
    modelId: readString(value, 'modelId'),
  };
}

async function readJson(filePath: string, label: string): Promise<unknown | undefined> {
  if (!(await pathExists(filePath))) return undefined;
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    logger.debug(`cline: failed to parse ${label}`, filePath, err);
    return undefined;
  }
}

/** Read and parse ui_messages.json, returning an empty array on failure */
async function readUiMessages(filePath: string): Promise<ClineRawMessage[]> {
  if (!(await pathExists(filePath))) return [];
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRawMessage).filter((msg): msg is ClineRawMessage => msg !== null);
  } catch (err) {
    logger.debug('cline: failed to parse ui_messages.json', filePath, err);
    return [];
  }
}

async function readApiConversationHistory(filePath: string): Promise<ClineApiMessage[]> {
  const parsed = await readJson(filePath, API_CONVERSATION_HISTORY_FILE);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeApiMessage).filter((message): message is ClineApiMessage => message !== null);
}

async function readTaskMetadata(filePath: string): Promise<ClineTaskMetadata | undefined> {
  return normalizeTaskMetadata(await readJson(filePath, TASK_METADATA_FILE));
}

function taskHistoryArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const taskHistory = value.taskHistory ?? value.history ?? value.items;
    if (Array.isArray(taskHistory)) return taskHistory;
  }
  return [];
}

async function readTaskHistoryMap(paths: string[]): Promise<TaskHistoryMap> {
  const itemsById: TaskHistoryMap = new Map();
  for (const filePath of paths) {
    const parsed = await readJson(filePath, TASK_HISTORY_FILE);
    for (const item of taskHistoryArray(parsed).map(normalizeTaskHistoryItem)) {
      if (item && !itemsById.has(item.id)) itemsById.set(item.id, item);
    }
  }
  return itemsById;
}

async function readTaskHistoryItem(paths: string[], taskId: string): Promise<ClineTaskHistoryItem | undefined> {
  return (await readTaskHistoryMap(paths)).get(taskId);
}

function taskHistoryCandidatesFromStorageRoot(storageRoot: string): string[] {
  return [path.join(storageRoot, 'state', TASK_HISTORY_FILE), path.join(storageRoot, TASK_HISTORY_FILE)];
}

function taskFilesFromDir(taskDir: string, storageRoot: string): TaskFiles {
  return {
    taskDir,
    storageRoot,
    uiMessages: path.join(taskDir, UI_MESSAGES_FILE),
    apiConversationHistory: path.join(taskDir, API_CONVERSATION_HISTORY_FILE),
    taskMetadata: path.join(taskDir, TASK_METADATA_FILE),
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
  taskHistoryById?: TaskHistoryMap,
): Promise<LoadedTaskData> {
  const files = taskFilesFromDir(taskDir, storageRoot);
  const [uiMessages, apiMessages, taskMetadata, taskHistoryItem] = await Promise.all([
    readUiMessages(files.uiMessages),
    readApiConversationHistory(files.apiConversationHistory),
    readTaskMetadata(files.taskMetadata),
    taskHistoryById
      ? Promise.resolve(taskHistoryById.get(taskId))
      : readTaskHistoryItem(files.taskHistoryCandidates, taskId),
  ]);

  return { files, uiMessages, apiMessages, taskMetadata, taskHistoryItem };
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

function chooseUsageNotes(data: LoadedTaskData): SessionNotes {
  const fromHistory = extractUsageFromTaskHistory(data.taskHistoryItem);
  if (fromHistory.tokenUsage || fromHistory.cacheTokens) return fromHistory;

  const fromApiHistory = extractUsageFromApiHistory(data.apiMessages);
  if (fromApiHistory.tokenUsage || fromApiHistory.cacheTokens) return fromApiHistory;

  return extractTokenUsage(data.uiMessages);
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

function resolveModel(data: LoadedTaskData): string | undefined {
  return (
    extractModelFromMetadata(data.taskMetadata) ??
    data.taskHistoryItem?.modelId ??
    extractModelFromApiHistory(data.apiMessages) ??
    extractModelFromUiMessages(data.uiMessages)
  );
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~/') || /^[A-Za-z]:[\\/]/u.test(value);
}

function findCwdInValue(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === 'string') return looksLikePath(value) ? value : extractCwdFromText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const cwd = findCwdInValue(item, depth + 1);
      if (cwd) return cwd;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const keys = [
    'cwd',
    'cwdOnTaskInitialization',
    'currentWorkingDirectory',
    'workingDirectory',
    'workspacePath',
    'rootPath',
    'projectRoot',
  ];
  for (const key of keys) {
    const raw = readString(value, key);
    if (raw && looksLikePath(raw)) return raw;
  }

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
    /\bcwd\s*[:=]\s*([^\n\r]+)/iu,
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

function resolveCwd(data: LoadedTaskData): string {
  return (
    data.taskHistoryItem?.cwdOnTaskInitialization ??
    extractCwdFromUiApiEvents(data.uiMessages) ??
    extractCwdFromApiHistory(data.apiMessages) ??
    ''
  );
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

function extractApiToolData(messages: ClineApiMessage[], config: VerbosityConfig): ToolData {
  const collector = new SummaryCollector(config);
  const resultMap = getToolResultMap(messages);

  for (const message of messages) {
    for (const block of apiContentBlocks(message.content)) {
      if (block.type !== 'tool_use' || !block.name) continue;
      const result = block.id ? resultMap.get(block.id) : undefined;
      addClineToolSummary(collector, block.name, block.input ?? {}, result, config);
    }
  }

  return {
    summaries: collector.getSummaries(),
    filesModified: collector.getFilesModified(),
  };
}

async function existingCompanionStats(
  files: TaskFiles,
): Promise<Array<{ filePath: string; size: number; birthtime: Date; mtime: Date }>> {
  const stats: Array<{ filePath: string; size: number; birthtime: Date; mtime: Date }> = [];
  for (const filePath of [files.uiMessages, files.apiConversationHistory, files.taskMetadata]) {
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
  const taskHistoryCache = new Map<string, Promise<TaskHistoryMap>>();
  const sessions: UnifiedSession[] = [];

  for (const { taskDir, taskId, storageRoot, source } of taskEntries) {
    try {
      const storageRootKey = path.resolve(storageRoot);
      let taskHistoryById = taskHistoryCache.get(storageRootKey);
      if (!taskHistoryById) {
        taskHistoryById = readTaskHistoryMap(taskHistoryCandidatesFromStorageRoot(storageRoot));
        taskHistoryCache.set(storageRootKey, taskHistoryById);
      }

      const data = await loadTaskData(taskDir, storageRoot, taskId, await taskHistoryById);
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
  const sessionNotes: SessionNotes = chooseUsageNotes(data);
  const model = resolveModel(data);
  if (model) sessionNotes.model = model;

  // Extract reasoning highlights
  const uiReasoning = extractReasoning(data.uiMessages, cfg.thinking?.maxHighlights ?? 5);
  const reasoning =
    uiReasoning.length > 0 ? uiReasoning : extractApiReasoning(data.apiMessages, cfg.thinking?.maxHighlights ?? 5);
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  // Extract pending tasks
  const pendingTasksFromUi = extractPendingTasks(data.uiMessages, cfg.pendingTasks?.maxTasks ?? 5);
  const pendingTasks =
    pendingTasksFromUi.length > 0
      ? pendingTasksFromUi
      : extractPendingTasksFromConversation(allConversation, cfg.pendingTasks?.maxTasks ?? 5);

  const toolData =
    data.apiMessages.length > 0 ? extractApiToolData(data.apiMessages, cfg) : { summaries: [], filesModified: [] };
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

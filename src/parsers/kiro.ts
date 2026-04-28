import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
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
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import { findFiles, listSubdirectories, mapConcurrent } from '../utils/fs-helpers.js';
import { readJsonlFile } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import { matchesCwd } from '../utils/slug.js';
import { mcpSummary, SummaryCollector } from '../utils/tool-summarizer.js';

// ── Kiro Storage ────────────────────────────────────────────────────────────

const KIRO_AGENT_RELATIVE_PATH = ['User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions'];
// The user-visible warning. Mentions both possible CLI SQLite locations:
//   - `~/Library/Application Support/kiro-cli/data.sqlite3` (verified primary CLI store, table conversations_v2)
//   - `~/.kiro/` (older / alternate location referenced in some docs)
// Wording stays compatible with the existing assertion (`SQLite stores under ~/.kiro/ are skipped`).
const KIRO_FIDELITY_WARNING =
  'Kiro fidelity warning: this parser supports IDE workspace JSON and ACP JSON/JSONL sessions; normal Kiro CLI SQLite stores under ~/.kiro/ are skipped (and the parallel store at ~/Library/Application Support/kiro-cli/data.sqlite3) because the exact schema is not publicly documented.';

// Canonical ACP `session/update` discriminator values per the agent-client-protocol schema:
//   https://github.com/zed-industries/agent-client-protocol/blob/main/schema/schema.json
// Verified against Kiro CLI v1.29.0 docs (kiro.dev/docs/cli/acp/) and the empirical reference at
//   https://github.com/dwalleck/cyril/blob/main/docs/kiro-acp-protocol.md
const ACP_SESSION_UPDATE_KEYS = ['sessionUpdate', 'type', 'kind', 'updateType', 'eventType'] as const;
const ACP_AGENT_MESSAGE_CHUNK = new Set(['agent_message_chunk', 'AgentMessageChunk']);
const ACP_AGENT_THOUGHT_CHUNK = new Set(['agent_thought_chunk', 'AgentThoughtChunk']);
const ACP_USER_MESSAGE_CHUNK = new Set(['user_message_chunk', 'UserMessageChunk']);
const ACP_TOOL_CALL = new Set(['tool_call', 'ToolCall', 'tool_call_chunk']);
const ACP_TOOL_CALL_UPDATE = new Set(['tool_call_update', 'ToolCallUpdate']);
const ACP_AGENT_MESSAGE = new Set(['agent_message', 'AgentMessage']);
const ACP_USER_MESSAGE = new Set(['user_message', 'UserMessage']);
// The canonical ACP spec has no `TurnEnd` event — turns end via the JSON-RPC response to
// `session/prompt` with `stopReason: end_turn`. We still recognise the legacy fixture name
// so synthesised `TurnEnd` events keep flushing accumulators harmlessly.
const ACP_TURN_END = new Set(['turn_end', 'TurnEnd']);

type KiroSurface = 'ide-workspace' | 'acp-jsonl';

interface KiroSessionRef {
  surface: KiroSurface;
  workspaceDir: string;
  workspacePath?: string;
  sessionPath: string;
  eventPath?: string;
  indexPath?: string;
  indexEntry?: JsonRecord;
}

type JsonRecord = Record<string, unknown>;
type KiroStatInfo = { stats: Pick<fs.Stats, 'size' | 'birthtime' | 'mtime'>; originalPath: string };

function getKiroWorkspaceSessionDirs(): string[] {
  const home = homeDir();
  const observedDirs = [
    path.join(home, 'Library', 'Application Support', 'Kiro', ...KIRO_AGENT_RELATIVE_PATH),
    path.join(home, '.config', 'Kiro', ...KIRO_AGENT_RELATIVE_PATH),
    path.join(home, 'AppData', 'Roaming', 'Kiro', ...KIRO_AGENT_RELATIVE_PATH),
  ];

  // Older parser revisions used this path. Keep it as a read-only fallback.
  const legacyDirs = [path.join(home, 'Library', 'Application Support', 'Kiro', 'workspace-sessions')];

  return Array.from(new Set([...observedDirs, ...legacyDirs])).filter((dir) => fs.existsSync(dir));
}

function getKiroAcpSessionDir(): string {
  return path.join(homeDir(), '.kiro', 'sessions', 'cli');
}

function isKiroAcpSessionPath(filePath: string): boolean {
  const sessionDir = path.dirname(filePath);
  return (
    path.basename(sessionDir) === 'cli' &&
    path.basename(path.dirname(sessionDir)) === 'sessions' &&
    path.basename(path.dirname(path.dirname(sessionDir))) === '.kiro'
  );
}

function getSiblingPath(filePath: string, extension: '.json' | '.jsonl'): string {
  return path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${extension}`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    logger.debug('kiro: failed to parse json file', filePath, err);
    return undefined;
  }
}

function getString(record: JsonRecord | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function getRecord(record: JsonRecord | undefined, keys: readonly string[]): JsonRecord | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return undefined;
}

function getNumber(record: JsonRecord | undefined, keys: readonly string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function parseDateValue(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return parseDateValue(numeric);

    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  return undefined;
}

function getDate(record: JsonRecord | undefined, keys: readonly string[]): Date | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const parsed = parseDateValue(record[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

function decodeWorkspaceFolderName(folderName: string): string | undefined {
  const normalized = folderName.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const trimmed = decoded.trim();
    if (
      trimmed.startsWith('/') ||
      trimmed.startsWith('~') ||
      trimmed.startsWith('file:') ||
      /^[A-Za-z]:[\\/]/.test(trimmed)
    ) {
      return trimmed;
    }
    return undefined;
  } catch (err) {
    logger.debug('kiro: failed to decode workspace folder', folderName, err);
    return undefined;
  }
}

function parseSessionIndex(data: unknown): JsonRecord[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];

  const candidates = [data.sessions, data.entries, data.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }

  return [];
}

async function readSessionIndex(indexPath: string): Promise<JsonRecord[]> {
  if (!fs.existsSync(indexPath)) return [];
  return parseSessionIndex(await readJsonFile(indexPath));
}

async function discoverSessionRefs(): Promise<KiroSessionRef[]> {
  const refs: KiroSessionRef[] = [];

  for (const baseDir of getKiroWorkspaceSessionDirs()) {
    for (const workspaceDir of listSubdirectories(baseDir)) {
      const workspacePath = decodeWorkspaceFolderName(path.basename(workspaceDir));
      const indexedSessionPaths = new Set<string>();
      const indexPath = path.join(workspaceDir, 'sessions.json');

      for (const entry of await readSessionIndex(indexPath)) {
        const sessionId = getString(entry, ['sessionId', 'id', 'conversationId']);
        if (!sessionId) continue;

        const sessionPath = path.join(workspaceDir, `${sessionId}.json`);
        indexedSessionPaths.add(path.resolve(sessionPath));
        refs.push({
          surface: 'ide-workspace',
          workspaceDir,
          workspacePath,
          sessionPath,
          indexPath,
          indexEntry: entry,
        });
      }

      const looseSessionFiles = findFiles(workspaceDir, {
        match: (entry) => entry.name.endsWith('.json') && entry.name !== 'sessions.json',
        recursive: false,
      });

      for (const sessionPath of looseSessionFiles) {
        if (indexedSessionPaths.has(path.resolve(sessionPath))) continue;
        refs.push({ surface: 'ide-workspace', workspaceDir, workspacePath, sessionPath });
      }
    }
  }

  const acpDir = getKiroAcpSessionDir();
  if (fs.existsSync(acpDir)) {
    const metadataFiles = findFiles(acpDir, {
      match: (entry) => entry.name.endsWith('.json'),
      recursive: false,
    });
    const metadataPaths = new Set(metadataFiles.map((filePath) => path.resolve(filePath)));

    for (const sessionPath of metadataFiles) {
      const eventPath = getSiblingPath(sessionPath, '.jsonl');
      refs.push({
        surface: 'acp-jsonl',
        workspaceDir: acpDir,
        sessionPath,
        eventPath: fs.existsSync(eventPath) ? eventPath : undefined,
      });
    }

    const eventFiles = findFiles(acpDir, {
      match: (entry) => entry.name.endsWith('.jsonl'),
      recursive: false,
    });
    for (const eventPath of eventFiles) {
      const metadataPath = getSiblingPath(eventPath, '.json');
      if (metadataPaths.has(path.resolve(metadataPath))) continue;
      refs.push({
        surface: 'acp-jsonl',
        workspaceDir: acpDir,
        sessionPath: eventPath,
        eventPath,
      });
    }
  }

  return refs;
}

function getHistoryEntries(sessionData: JsonRecord | undefined): unknown[] {
  if (!sessionData) return [];
  if (Array.isArray(sessionData.history)) return sessionData.history;
  if (Array.isArray(sessionData.messages)) return sessionData.messages;
  return [];
}

function normalizeRole(role: unknown): ConversationMessage['role'] | undefined {
  if (role === 'user' || role === 'human') return 'user';
  if (role === 'assistant' || role === 'ai') return 'assistant';
  return undefined;
}

function extractBlockText(block: unknown): string {
  if (!isRecord(block)) return '';

  const type = typeof block.type === 'string' ? block.type : undefined;
  const kind = typeof block.kind === 'string' ? block.kind : undefined;
  const hasBlockKind = type !== undefined || kind !== undefined;
  if (hasBlockKind && type !== 'text' && kind !== 'text') return '';

  if (typeof block.text === 'string') return block.text;
  if (typeof block.data === 'string') return block.data;
  return '';
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractBlockText).filter(Boolean).join('\n');
  if (isRecord(content)) {
    const blockText = extractBlockText(content);
    if (blockText) return blockText;

    for (const key of ['content', 'text', 'data', 'message', 'delta', 'chunk']) {
      const nested: unknown = content[key];
      if (nested === content) continue;
      const nestedText = extractContent(nested);
      if (nestedText) return nestedText;
    }
  }
  return '';
}

function normalizeHistoryEntry(entry: unknown): ConversationMessage | undefined {
  if (!isRecord(entry)) return undefined;
  const message = isRecord(entry.message) ? entry.message : entry;
  const role = normalizeRole(message.role ?? entry.role);
  if (!role) return undefined;

  const content = extractContent(message.content ?? message.text ?? entry.content).trim();
  if (!content) return undefined;

  return {
    role,
    content,
    timestamp:
      getDate(message, ['timestamp', 'createdAt', 'dateCreated']) ?? getDate(entry, ['timestamp', 'createdAt']),
  };
}

function extractMessages(sessionData: JsonRecord | undefined): ConversationMessage[] {
  return getHistoryEntries(sessionData).flatMap((entry) => {
    const message = normalizeHistoryEntry(entry);
    return message ? [message] : [];
  });
}

async function readAcpEvents(eventPath: string | undefined): Promise<unknown[]> {
  if (!eventPath || !fs.existsSync(eventPath)) return [];
  return readJsonlFile<unknown>(eventPath);
}

function getAcpUpdate(record: JsonRecord): JsonRecord | undefined {
  const params = getRecord(record, ['params']);
  const update = getRecord(params, ['update']);
  if (update) return update;

  const nested = getRecord(record, ['update', 'event']);
  if (nested) return nested;

  return getAcpRecordType(record) ? record : undefined;
}

function getAcpRecordType(record: JsonRecord | undefined): string | undefined {
  return getString(record, ACP_SESSION_UPDATE_KEYS);
}

function extractAcpRecordText(record: JsonRecord | undefined): string {
  if (!record) return '';
  for (const key of ['content', 'text', 'message', 'delta', 'chunk', 'data']) {
    if (!(key in record)) continue;
    const text = extractContent(record[key]);
    if (text.length > 0 || typeof record[key] === 'string') return text;
  }
  return '';
}

function extractPromptText(record: JsonRecord): string {
  const params = getRecord(record, ['params']);
  return extractAcpRecordText(params).trim();
}

function extractAcpTimestamp(record: JsonRecord, fallback?: JsonRecord): Date | undefined {
  return (
    getDate(record, ['timestamp', 'createdAt', 'dateCreated', 'time']) ??
    getDate(fallback, ['timestamp', 'createdAt', 'dateCreated', 'time'])
  );
}

// Kiro CLI persists session history in `~/.kiro/sessions/cli/<id>.jsonl` using
// envelope objects keyed by `AssistantMessage` / `UserMessage` / `ToolResults`,
// not raw ACP `session/update` notifications (see kirodotdev/Kiro#6110). We
// peel the envelope so the same parser handles both wire-protocol replay logs
// and Kiro's persisted record format.
const KIRO_PERSISTED_ENVELOPE_KEYS = [
  'AssistantMessage',
  'UserMessage',
  'ToolResults',
  'assistantMessage',
  'userMessage',
  'toolResults',
] as const;

function unwrapKiroPersistedEnvelope(
  event: JsonRecord,
): { kind: 'assistant' | 'user' | 'tool_results'; payload: JsonRecord } | undefined {
  for (const key of KIRO_PERSISTED_ENVELOPE_KEYS) {
    const value = event[key];
    if (!isRecord(value)) continue;
    const lowered = key.toLowerCase();
    if (lowered === 'assistantmessage') return { kind: 'assistant', payload: value };
    if (lowered === 'usermessage') return { kind: 'user', payload: value };
    if (lowered === 'toolresults') return { kind: 'tool_results', payload: value };
  }
  return undefined;
}

function extractAcpMessages(events: readonly unknown[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let pendingAssistant = '';
  let pendingAssistantTimestamp: Date | undefined;
  let pendingUser = '';
  let pendingUserTimestamp: Date | undefined;
  // Track JSON-RPC `session/prompt` request ids so we can flush on the
  // matching response (`stopReason` carries `end_turn`/`max_tokens`/`cancelled`).
  const promptRequestIds = new Set<string>();

  const flushAssistant = (): void => {
    const content = pendingAssistant;
    pendingAssistant = '';
    const timestamp = pendingAssistantTimestamp;
    pendingAssistantTimestamp = undefined;
    if (content.trim().length === 0) return;
    messages.push({ role: 'assistant', content: content.trim(), timestamp });
  };

  const flushUser = (): void => {
    const content = pendingUser;
    pendingUser = '';
    const timestamp = pendingUserTimestamp;
    pendingUserTimestamp = undefined;
    if (content.trim().length === 0) return;
    messages.push({ role: 'user', content: content.trim(), timestamp });
  };

  const isPromptResponse = (event: JsonRecord): boolean => {
    if (typeof event.method === 'string') return false;
    const id = event.id;
    if (id === undefined || id === null) return false;
    const idKey = String(id);
    if (!promptRequestIds.has(idKey)) return false;
    promptRequestIds.delete(idKey);
    return true;
  };

  for (const event of events) {
    if (!isRecord(event)) continue;

    // Kiro CLI persisted-format envelopes (`AssistantMessage`/`UserMessage`/`ToolResults`).
    const persisted = unwrapKiroPersistedEnvelope(event);
    if (persisted) {
      if (persisted.kind === 'tool_results') {
        // Tool results don't represent visible turns of conversation; surface them via
        // tool summaries instead. Skip here.
        continue;
      }
      if (persisted.kind === 'user') {
        flushAssistant();
        flushUser();
        const content = extractAcpRecordText(persisted.payload).trim();
        if (content) {
          messages.push({
            role: 'user',
            content,
            timestamp: extractAcpTimestamp(persisted.payload, event),
          });
        }
        continue;
      }
      // assistant
      flushAssistant();
      flushUser();
      const content = extractAcpRecordText(persisted.payload).trim();
      if (content) {
        messages.push({
          role: 'assistant',
          content,
          timestamp: extractAcpTimestamp(persisted.payload, event),
        });
      }
      continue;
    }

    const method = getString(event, ['method']);
    if (method === 'session/prompt') {
      flushAssistant();
      flushUser();
      const id = event.id;
      if (id !== undefined && id !== null) promptRequestIds.add(String(id));
      const content = extractPromptText(event);
      if (content) {
        messages.push({
          role: 'user',
          content,
          timestamp: extractAcpTimestamp(event, getRecord(event, ['params'])),
        });
      }
      continue;
    }

    // The ACP `session/prompt` JSON-RPC response (correlated to a tracked id) signals
    // turn end via `stopReason`. Flush any streaming assistant accumulator.
    if (isPromptResponse(event)) {
      flushAssistant();
      continue;
    }

    const update = getAcpUpdate(event);
    if (!update) {
      const directMessage = normalizeHistoryEntry(event);
      if (directMessage) {
        if (directMessage.role === 'user') {
          flushAssistant();
          flushUser();
        }
        messages.push(directMessage);
      }
      continue;
    }

    const updateType = getAcpRecordType(update);

    if (updateType && ACP_AGENT_MESSAGE_CHUNK.has(updateType)) {
      const chunk = extractAcpRecordText(update);
      if (chunk.length > 0) {
        // Starting a new assistant turn flushes any pending streamed user prompt.
        flushUser();
        pendingAssistant += chunk;
        pendingAssistantTimestamp ??= extractAcpTimestamp(update, event);
      }
      continue;
    }

    if (updateType && ACP_AGENT_THOUGHT_CHUNK.has(updateType)) {
      // Thought chunks are extended-thinking traces, not user-visible conversation per the
      // ACP schema. Skip them so they don't pollute the main message stream.
      continue;
    }

    if (updateType && ACP_USER_MESSAGE_CHUNK.has(updateType)) {
      const chunk = extractAcpRecordText(update);
      if (chunk.length > 0) {
        flushAssistant();
        pendingUser += chunk;
        pendingUserTimestamp ??= extractAcpTimestamp(update, event);
      }
      continue;
    }

    if (updateType && ACP_AGENT_MESSAGE.has(updateType)) {
      flushAssistant();
      flushUser();
      const content = extractAcpRecordText(update).trim();
      if (content) {
        messages.push({
          role: 'assistant',
          content,
          timestamp: extractAcpTimestamp(update, event),
        });
      }
      continue;
    }

    if (updateType && ACP_USER_MESSAGE.has(updateType)) {
      flushAssistant();
      flushUser();
      const content = extractAcpRecordText(update).trim();
      if (content) {
        messages.push({
          role: 'user',
          content,
          timestamp: extractAcpTimestamp(update, event),
        });
      }
      continue;
    }

    if (updateType && ACP_TURN_END.has(updateType)) {
      flushAssistant();
      flushUser();
      continue;
    }

    const directMessage = normalizeHistoryEntry(update);
    if (directMessage) {
      if (directMessage.role === 'user') {
        flushAssistant();
        flushUser();
      }
      messages.push(directMessage);
    }
  }

  flushAssistant();
  flushUser();
  return messages;
}

function extractAcpCwd(sessionData: JsonRecord | undefined, events: readonly unknown[]): string {
  const metadataCwd = getString(sessionData, ['workspacePath', 'workspace', 'cwd', 'workingDirectory', 'directory']);
  if (metadataCwd) return metadataCwd;

  for (const event of events) {
    if (!isRecord(event)) continue;
    if (getString(event, ['method']) !== 'session/new') continue;

    const cwd = getString(getRecord(event, ['params']), ['cwd', 'workspacePath', 'workingDirectory', 'directory']);
    if (cwd) return cwd;
  }

  return '';
}

function extractAcpModel(sessionData: JsonRecord | undefined, events: readonly unknown[]): string | undefined {
  // Kiro v1.29.0 added `models.currentModelId` in `session/new`; honour it after metadata.
  const metadataModel = getString(sessionData, ['selectedModel', 'model', 'modelId']);
  if (metadataModel) return metadataModel;
  const modelsBlock = getRecord(sessionData, ['models']);
  const currentMetadataModel = getString(modelsBlock, ['currentModelId', 'modelId']);
  if (currentMetadataModel) return currentMetadataModel;

  for (const event of events) {
    if (!isRecord(event)) continue;

    const params = getRecord(event, ['params']);
    const model = getString(params, ['model', 'modelId', 'selectedModel']);
    if (model) return model;

    // Inspect `session/new` and `session/load` responses (`{result: {models: {...}}}`).
    const result = getRecord(event, ['result']);
    const resultModels = getRecord(result, ['models']);
    const fromResult = getString(resultModels, ['currentModelId', 'modelId']);
    if (fromResult) return fromResult;
  }

  return undefined;
}

function formatToolParams(record: JsonRecord | undefined): string {
  // Canonical ACP `ToolCall.rawInput` first, then Kiro extension `parameters`,
  // then generic `params`/`arguments`/`input` for tolerance.
  const params = getRecord(record, ['rawInput', 'parameters', 'params', 'arguments', 'input']);
  if (!params) return '';
  try {
    return JSON.stringify(params);
  } catch (err) {
    logger.debug('kiro: failed to stringify ACP tool params', err);
    return '';
  }
}

// Pull a textual representation of a tool call's output. The canonical ACP
// `ToolCall.content[]` is a list of `ToolCallContent` discriminated by `type`
// (`content` → ContentBlock; `diff` → diff record). Kiro additionally exposes
// flat `output`/`rawOutput` strings/objects on `tool_call_update`.
function extractAcpToolResult(record: JsonRecord | undefined): string {
  if (!record) return '';
  if (typeof record.output === 'string') return record.output;
  if (typeof record.rawOutput === 'string') return record.rawOutput;
  const flat = extractContent(record.output ?? record.rawOutput ?? record.result).trim();
  if (flat) return flat;
  const contentArray = record.content;
  if (Array.isArray(contentArray)) {
    const parts: string[] = [];
    for (const item of contentArray) {
      if (!isRecord(item)) continue;
      const itemType = typeof item.type === 'string' ? item.type : undefined;
      // ToolCallContent { type: "content", content: ContentBlock }
      if (itemType === 'content') {
        const inner = extractContent(item.content);
        if (inner) parts.push(inner);
        continue;
      }
      // ToolCallContent { type: "diff", oldText, newText, path }
      if (itemType === 'diff') {
        const path = typeof item.path === 'string' ? item.path : '';
        const oldText = typeof item.oldText === 'string' ? item.oldText : '';
        const newText = typeof item.newText === 'string' ? item.newText : '';
        const summary = path ? `diff ${path}` : 'diff';
        const stats = `(${oldText.length} → ${newText.length} chars)`;
        parts.push(`${summary} ${stats}`.trim());
        continue;
      }
      // Plain ContentBlock or string fallback.
      const text = extractContent(item);
      if (text) parts.push(text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}

interface AcpToolInvocation {
  toolName: string;
  params: string;
  result: string;
  status?: string;
  isError: boolean;
}

function getAcpToolCallId(record: JsonRecord | undefined): string | undefined {
  return getString(record, ['toolCallId', 'callId', 'id', 'toolUseId', 'invocationId']);
}

function isFailedToolStatus(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  return normalized === 'error' || normalized === 'failed';
}

function mergeAcpToolUpdate(invocation: AcpToolInvocation, update: JsonRecord): void {
  // Canonical ACP `ToolCall.title` (preferred) or Kiro `name` extension.
  const updateToolName = getString(update, ['name', 'toolName', 'title']);
  if (updateToolName && invocation.toolName === '__acp_pending__') {
    invocation.toolName = updateToolName;
  } else if (updateToolName && updateToolName !== invocation.toolName) {
    // Mismatch — skip silently. ACP allows a `kind` change but tool identity should stay.
    return;
  }

  const params = formatToolParams(update);
  if (!invocation.params && params) invocation.params = params;

  const result = extractAcpToolResult(update);
  if (result) invocation.result = result;

  const status = getString(update, ['status', 'state']);
  if (status) {
    invocation.status = status;
    invocation.isError ||= isFailedToolStatus(status);
  }
}

function extractAcpToolSummaries(events: readonly unknown[], config?: VerbosityConfig): ToolUsageSummary[] {
  const invocations: AcpToolInvocation[] = [];
  const invocationsById = new Map<string, AcpToolInvocation>();

  const upsertToolCall = (update: JsonRecord): void => {
    const toolCallId = getAcpToolCallId(update);
    // Canonical ACP requires `title`; Kiro extension uses `name`. Either is acceptable.
    const toolName = getString(update, ['name', 'toolName', 'title']);
    const status = getString(update, ['status', 'state']);

    const existing = toolCallId ? invocationsById.get(toolCallId) : undefined;
    if (existing) {
      // De-dupe: an early `tool_call_chunk` (kiro.dev extension) often arrives before the
      // standard `tool_call` notification. Update the existing record rather than spawning
      // a duplicate.
      mergeAcpToolUpdate(existing, update);
      return;
    }
    if (!toolName && !toolCallId) return;

    const invocation: AcpToolInvocation = {
      toolName: toolName ?? '__acp_pending__',
      params: formatToolParams(update),
      result: extractAcpToolResult(update),
      status,
      isError: isFailedToolStatus(status),
    };
    invocations.push(invocation);
    if (toolCallId) invocationsById.set(toolCallId, invocation);
  };

  for (const event of events) {
    if (!isRecord(event)) continue;

    // Persisted Kiro CLI `ToolResults` envelope: surface as a generic tool call so the
    // summary collector reports activity even when no wire-protocol notification was logged.
    const persisted = unwrapKiroPersistedEnvelope(event);
    if (persisted?.kind === 'tool_results') {
      const list = Array.isArray(persisted.payload.results)
        ? persisted.payload.results
        : Array.isArray(persisted.payload.toolResults)
          ? persisted.payload.toolResults
          : Array.isArray(event.toolResults)
            ? event.toolResults
            : [persisted.payload];
      for (const item of list) {
        if (!isRecord(item)) continue;
        const inner = isRecord(item.toolResult) ? item.toolResult : item;
        const toolCallId = getAcpToolCallId(inner) ?? getAcpToolCallId(item);
        const innerStatus = getString(inner, ['status', 'state']);
        // Default a tool result to `completed` when the inner record doesn't say otherwise:
        // the presence of a ToolResults envelope itself implies the call has finished.
        const status = innerStatus ?? 'completed';
        const existing = toolCallId ? invocationsById.get(toolCallId) : undefined;
        if (existing) {
          const result = extractAcpToolResult(inner);
          if (result) existing.result = result;
          existing.status = status;
          existing.isError ||= isFailedToolStatus(status);
          continue;
        }
        // Unknown call id — synthesize a record so the summary still mentions tool activity.
        const result = extractAcpToolResult(inner);
        const toolName = getString(inner, ['name', 'toolName', 'title']) ?? 'tool';
        const synthetic: AcpToolInvocation = {
          toolName,
          params: formatToolParams(inner),
          result,
          status,
          isError: isFailedToolStatus(status),
        };
        invocations.push(synthetic);
        if (toolCallId) invocationsById.set(toolCallId, synthetic);
      }
      continue;
    }
    if (persisted?.kind === 'assistant') {
      // Persisted assistant messages may carry inline `toolUse` arrays — Anthropic-style.
      const toolUseList = Array.isArray(persisted.payload.toolUse)
        ? persisted.payload.toolUse
        : Array.isArray(persisted.payload.tool_use)
          ? persisted.payload.tool_use
          : [];
      for (const item of toolUseList) {
        if (!isRecord(item)) continue;
        upsertToolCall(item);
      }
      continue;
    }

    const update = getAcpUpdate(event);
    const updateType = getAcpRecordType(update);
    if (!update) continue;

    if (updateType && ACP_TOOL_CALL.has(updateType)) {
      upsertToolCall(update);
      continue;
    }

    if (updateType && ACP_TOOL_CALL_UPDATE.has(updateType)) {
      const toolCallId = getAcpToolCallId(update);
      const invocation = toolCallId ? invocationsById.get(toolCallId) : undefined;
      if (invocation) mergeAcpToolUpdate(invocation, update);
      else if (toolCallId) {
        // Lone `tool_call_update` with no preceding `tool_call` — keep it but mark name unknown.
        upsertToolCall(update);
      }
    }
  }

  // Drop any invocation that never received a name.
  for (let i = invocations.length - 1; i >= 0; i--) {
    if (invocations[i].toolName === '__acp_pending__') invocations.splice(i, 1);
  }

  const collector = new SummaryCollector(config);

  for (const invocation of invocations) {
    const summary = `${mcpSummary(invocation.toolName, invocation.params, invocation.result)}${
      invocation.status ? ` [${invocation.status}]` : ''
    }`;

    collector.add(invocation.toolName, summary, {
      data: {
        category: 'mcp',
        toolName: invocation.toolName,
        ...(invocation.params ? { params: invocation.params } : {}),
        ...(invocation.result ? { result: invocation.result } : {}),
      },
      isError: invocation.isError,
    });
  }

  return collector.getSummaries();
}

function firstUserMessage(messages: readonly ConversationMessage[]): string {
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

function getSessionId(ref: KiroSessionRef, sessionData: JsonRecord | undefined): string | undefined {
  return (
    getString(ref.indexEntry, ['sessionId', 'id', 'conversationId']) ??
    getString(sessionData, ['sessionId', 'id', 'conversationId']) ??
    path.basename(ref.sessionPath, path.extname(ref.sessionPath))
  );
}

function getTitle(ref: KiroSessionRef, sessionData: JsonRecord | undefined): string | undefined {
  return (
    getString(sessionData, ['title', 'customTitle', 'name']) ??
    getString(ref.indexEntry, ['title', 'customTitle', 'name'])
  );
}

function getWorkspacePath(ref: KiroSessionRef, sessionData: JsonRecord | undefined): string {
  return (
    getString(sessionData, ['workspacePath', 'workspace', 'cwd', 'directory']) ??
    getString(ref.indexEntry, ['workspacePath', 'workspace', 'cwd', 'directory']) ??
    ref.workspacePath ??
    ''
  );
}

function getModel(ref: KiroSessionRef, sessionData: JsonRecord | undefined): string | undefined {
  return getString(sessionData, ['selectedModel', 'model']) ?? getString(ref.indexEntry, ['selectedModel', 'model']);
}

function getMessageCount(
  ref: KiroSessionRef,
  sessionData: JsonRecord | undefined,
  messages: readonly ConversationMessage[],
): number {
  return (
    getNumber(ref.indexEntry, ['messageCount', 'bubbleCount']) ??
    getNumber(sessionData, ['messageCount', 'bubbleCount']) ??
    messages.length
  );
}

function buildSummary(
  ref: KiroSessionRef,
  sessionData: JsonRecord | undefined,
  messages: readonly ConversationMessage[],
  cwd: string,
  sessionId: string,
): string {
  const userSummary = cleanSummary(firstUserMessage(messages));
  if (userSummary) return userSummary;

  const title = cleanSummary(getTitle(ref, sessionData) ?? '');
  if (title) return title;

  const workspaceName = cwd ? cleanSummary(path.basename(cwd)) : '';
  return workspaceName || sessionId;
}

async function statSessionRef(ref: KiroSessionRef): Promise<KiroStatInfo | undefined> {
  try {
    if (ref.surface === 'acp-jsonl') {
      const candidatePaths = [ref.sessionPath, ref.eventPath].filter((filePath): filePath is string => {
        if (!filePath) return false;
        return fs.existsSync(filePath);
      });
      // De-dupe so lone-jsonl refs (where sessionPath === eventPath) do not double-count bytes.
      const paths = Array.from(new Set(candidatePaths.map((filePath) => path.resolve(filePath))));
      if (paths.length === 0) return undefined;

      const stats = await Promise.all(paths.map((filePath) => fsp.stat(filePath)));
      const aggregateStats = {
        size: stats.reduce((total, stat) => total + stat.size, 0),
        birthtime: new Date(Math.min(...stats.map((stat) => stat.birthtime.getTime()))),
        mtime: new Date(Math.max(...stats.map((stat) => stat.mtime.getTime()))),
      };
      return { stats: aggregateStats, originalPath: ref.sessionPath };
    }

    if (fs.existsSync(ref.sessionPath)) {
      return { stats: await fsp.stat(ref.sessionPath), originalPath: ref.sessionPath };
    }
    if (ref.indexPath && fs.existsSync(ref.indexPath)) {
      return { stats: await fsp.stat(ref.indexPath), originalPath: ref.indexPath };
    }
  } catch (err) {
    logger.debug('kiro: failed to stat session ref', ref.sessionPath, err);
  }
  return undefined;
}

async function parseAcpSessionRef(ref: KiroSessionRef, options: SessionParseOptions): Promise<UnifiedSession | null> {
  const sessionData = ref.sessionPath.endsWith('.json') ? await readJsonFile(ref.sessionPath) : undefined;
  if (ref.sessionPath.endsWith('.json') && sessionData === undefined) return null;

  const sessionRecord = isRecord(sessionData) ? sessionData : undefined;
  const events = await readAcpEvents(ref.eventPath);
  const sessionId = getSessionId(ref, sessionRecord);
  if (!sessionId) return null;

  const statInfo = await statSessionRef(ref);
  if (!statInfo) return null;

  const eventMessages = extractAcpMessages(events);
  const jsonMessages = extractMessages(sessionRecord);
  const messages = eventMessages.length > 0 ? eventMessages : jsonMessages;
  const cwd = extractAcpCwd(sessionRecord, events);
  if (options.cwd && cwd && !matchesCwd(cwd, options.cwd)) return null;

  const createdAt =
    getDate(sessionRecord, ['dateCreated', 'createdAt', 'creationDate']) ??
    getDate(getRecord(sessionRecord, ['metadata']), ['dateCreated', 'createdAt', 'creationDate']) ??
    statInfo.stats.birthtime;
  const updatedAt =
    getDate(sessionRecord, ['dateUpdated', 'updatedAt', 'lastUpdatedAt', 'lastMessageDate']) ??
    getDate(getRecord(sessionRecord, ['metadata']), ['dateUpdated', 'updatedAt', 'lastUpdatedAt', 'lastMessageDate']) ??
    statInfo.stats.mtime;

  return {
    id: sessionId,
    source: 'kiro',
    cwd,
    repo: extractRepoFromCwd(cwd) || undefined,
    lines: getMessageCount(ref, sessionRecord, messages),
    bytes: statInfo.stats.size,
    createdAt,
    updatedAt,
    originalPath: statInfo.originalPath,
    summary: buildSummary(ref, sessionRecord, messages, cwd, sessionId),
    model: extractAcpModel(sessionRecord, events),
  };
}

async function parseSessionRef(ref: KiroSessionRef, options: SessionParseOptions): Promise<UnifiedSession | null> {
  if (ref.surface === 'acp-jsonl') return parseAcpSessionRef(ref, options);

  const sessionFileExists = fs.existsSync(ref.sessionPath);
  const sessionData = sessionFileExists ? await readJsonFile(ref.sessionPath) : undefined;
  if (sessionFileExists && sessionData === undefined && !ref.indexEntry) return null;

  const sessionRecord = isRecord(sessionData) ? sessionData : undefined;
  const sessionId = getSessionId(ref, sessionRecord);
  if (!sessionId) return null;

  const statInfo = await statSessionRef(ref);
  if (!statInfo) return null;

  const cwd = getWorkspacePath(ref, sessionRecord);
  if (options.cwd && cwd && !matchesCwd(cwd, options.cwd)) return null;

  const messages = extractMessages(sessionRecord);
  const createdAt =
    getDate(ref.indexEntry, ['dateCreated', 'createdAt', 'creationDate']) ??
    getDate(sessionRecord, ['dateCreated', 'createdAt', 'creationDate']) ??
    statInfo.stats.birthtime;
  const updatedAt =
    getDate(sessionRecord, ['dateUpdated', 'updatedAt', 'lastUpdatedAt', 'lastMessageDate']) ??
    getDate(ref.indexEntry, ['dateUpdated', 'updatedAt', 'lastUpdatedAt', 'lastMessageDate']) ??
    statInfo.stats.mtime;

  const summary = buildSummary(ref, sessionRecord, messages, cwd, sessionId);
  const model = getModel(ref, sessionRecord);

  return {
    id: sessionId,
    source: 'kiro',
    cwd,
    repo: extractRepoFromCwd(cwd) || undefined,
    lines: getMessageCount(ref, sessionRecord, messages),
    bytes: statInfo.stats.size,
    createdAt,
    updatedAt,
    originalPath: statInfo.originalPath,
    summary,
    model,
  };
}

/**
 * Parse all Kiro sessions into the unified format.
 */
export async function parseKiroSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const refs = await discoverSessionRefs();
  const parsedSessions = await mapConcurrent(refs, 16, async (ref) => {
    try {
      return await parseSessionRef(ref, options);
    } catch (err) {
      logger.debug('kiro: skipping unparseable session', ref.sessionPath, err);
      return null;
    }
  });

  const sessionsById = new Map<string, UnifiedSession>();
  for (const session of parsedSessions) {
    if (!session) continue;
    const existing = sessionsById.get(session.id);
    if (!existing || existing.updatedAt.getTime() < session.updatedAt.getTime()) {
      sessionsById.set(session.id, session);
    }
  }

  const sorted = Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return options.limit ? sorted.slice(0, options.limit) : sorted;
}

async function readSiblingIndexEntry(session: UnifiedSession): Promise<JsonRecord | undefined> {
  const indexPath =
    path.basename(session.originalPath) === 'sessions.json'
      ? session.originalPath
      : path.join(path.dirname(session.originalPath), 'sessions.json');

  const entries = await readSessionIndex(indexPath);
  return entries.find((entry) => getString(entry, ['sessionId', 'id', 'conversationId']) === session.id);
}

function resolveContextSessionPath(session: UnifiedSession): string {
  if (path.basename(session.originalPath) === 'sessions.json') {
    return path.join(path.dirname(session.originalPath), `${session.id}.json`);
  }
  return session.originalPath;
}

function buildSessionNotes(session: UnifiedSession): SessionNotes {
  return {
    ...(session.model ? { model: session.model } : {}),
    sourceMetadata: {
      supportedSurfaces: ['ide-workspace-json', 'acp-json-jsonl'],
      skippedSurfaces: ['cli-sqlite'],
    },
    fidelityWarnings: [KIRO_FIDELITY_WARNING],
  };
}

function buildKiroTimeline(messages: readonly ConversationMessage[]): SessionEvent[] {
  const timeline: SessionEvent[] = messages.map((message, index) => ({
    kind: 'message',
    sequence: index,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    sourceId: message.sourceId,
    sourceParentId: message.sourceParentId,
    isMeta: message.isMeta,
  }));

  timeline.push({
    kind: 'warning',
    sequence: timeline.length,
    content: KIRO_FIDELITY_WARNING,
  });

  return timeline;
}

function resolveAcpContextPaths(session: UnifiedSession): { metadataPath?: string; eventPath?: string } {
  if (session.originalPath.endsWith('.jsonl')) {
    const metadataPath = getSiblingPath(session.originalPath, '.json');
    return {
      metadataPath: fs.existsSync(metadataPath) ? metadataPath : undefined,
      eventPath: session.originalPath,
    };
  }

  if (session.originalPath.endsWith('.json')) {
    const eventPath = getSiblingPath(session.originalPath, '.jsonl');
    return {
      metadataPath: session.originalPath,
      eventPath: fs.existsSync(eventPath) ? eventPath : undefined,
    };
  }

  return {};
}

/**
 * Extract context from a Kiro session for cross-tool continuation.
 */
export async function extractKiroContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  if (isKiroAcpSessionPath(session.originalPath)) {
    const paths = resolveAcpContextPaths(session);
    const sessionData = paths.metadataPath ? await readJsonFile(paths.metadataPath) : undefined;
    const sessionRecord = isRecord(sessionData) ? sessionData : undefined;
    const events = await readAcpEvents(paths.eventPath);
    const eventMessages = extractAcpMessages(events);
    const jsonMessages = extractMessages(sessionRecord);
    const messages = trimMessages(eventMessages.length > 0 ? eventMessages : jsonMessages, cfg.recentMessages);
    const cwd = extractAcpCwd(sessionRecord, events) || session.cwd;
    const model = extractAcpModel(sessionRecord, events) ?? session.model;
    const enrichedSession: UnifiedSession = {
      ...session,
      cwd,
      repo: session.repo || extractRepoFromCwd(cwd) || undefined,
      model,
    };
    const filesModified: string[] = [];
    const pendingTasks: string[] = [];
    const toolSummaries = extractAcpToolSummaries(events, cfg);
    const sessionNotes = buildSessionNotes(enrichedSession);
    const timeline = buildKiroTimeline(messages);

    const markdown = generateHandoffMarkdown(
      enrichedSession,
      messages,
      filesModified,
      pendingTasks,
      toolSummaries,
      sessionNotes,
      cfg,
      'inline',
      timeline,
    );

    return {
      session: enrichedSession,
      recentMessages: messages,
      filesModified,
      pendingTasks,
      toolSummaries,
      sessionNotes,
      timeline,
      markdown,
    };
  }

  const sessionPath = resolveContextSessionPath(session);
  const sessionData = fs.existsSync(sessionPath) ? await readJsonFile(sessionPath) : undefined;
  const sessionRecord = isRecord(sessionData) ? sessionData : undefined;
  const indexEntry = await readSiblingIndexEntry(session);
  const workspacePath = getWorkspacePath(
    {
      surface: 'ide-workspace',
      workspaceDir: path.dirname(sessionPath),
      workspacePath: decodeWorkspaceFolderName(path.basename(path.dirname(sessionPath))),
      sessionPath,
      indexEntry,
    },
    sessionRecord,
  );
  const model = getModel(
    { surface: 'ide-workspace', workspaceDir: path.dirname(sessionPath), sessionPath, indexEntry },
    sessionRecord,
  );
  const messages = trimMessages(extractMessages(sessionRecord), cfg.recentMessages);
  const enrichedSession: UnifiedSession = {
    ...session,
    cwd: workspacePath || session.cwd,
    repo: session.repo || extractRepoFromCwd(workspacePath || session.cwd) || undefined,
    model: model ?? session.model,
  };

  // Public Kiro IDE evidence exposes session metadata and text blocks, not a stable
  // tool-call schema in workspace-session JSON. Keep tool extraction explicitly empty.
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];
  const toolSummaries: ToolUsageSummary[] = [];
  const sessionNotes = buildSessionNotes(enrichedSession);
  const timeline = buildKiroTimeline(messages);

  const markdown = generateHandoffMarkdown(
    enrichedSession,
    messages,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    cfg,
    'inline',
    timeline,
  );

  return {
    session: enrichedSession,
    recentMessages: messages,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

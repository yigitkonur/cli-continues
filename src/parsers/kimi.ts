import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import type { KimiMessage } from '../types/schemas.js';
import { classifyToolName } from '../types/tool-names.js';
import { extractTextFromBlocks } from '../utils/content.js';
import { readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import { fileSummary, mcpSummary, SummaryCollector, shellSummary, truncate } from '../utils/tool-summarizer.js';

/**
 * Resolve the Kimi Code CLI share directory.
 *
 * Kimi Code v2 (>= 0.39) stores runtime data under `~/.kimi-code` and honors
 * `KIMI_CODE_HOME`. `KIMI_SHARE_DIR` is kept as a legacy override for older
 * installs and for sandboxed test fixtures.
 */
function getKimiShareDir(): string {
  const configured = process.env.KIMI_CODE_HOME?.trim() || process.env.KIMI_SHARE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir(), '.kimi-code');
}

/**
 * Legacy Kimi share dir (pre-0.39 layout with `~/.kimi/sessions/<md5>/`).
 * Only used as a fallback so old sessions remain discoverable after an upgrade.
 */
function getLegacyKimiShareDir(): string {
  const configured = process.env.KIMI_SHARE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir(), '.kimi');
}

const KIMI_SHARE_DIR = getKimiShareDir();
const KIMI_SESSIONS_DIR = path.join(KIMI_SHARE_DIR, 'sessions');
const KIMI_SESSION_INDEX_PATH = path.join(KIMI_SHARE_DIR, 'session_index.jsonl');
const KIMI_WORKSPACES_PATH = path.join(KIMI_SHARE_DIR, 'workspaces.json');
const KIMI_LEGACY_SESSIONS_DIR = path.join(getLegacyKimiShareDir(), 'sessions');
const KIMI_CONFIG_PATH = path.join(getLegacyKimiShareDir(), 'kimi.json');

type KimiSessionIndexEntry = {
  sessionId?: string;
  sessionDir?: string;
  workDir?: string;
};

type KimiSessionPath = {
  path: string;
  layout: 'v2' | 'legacy';
  indexEntry?: KimiSessionIndexEntry;
};

type KimiWorkDirEntry = { path: string; kaos?: string };
type KimiSessionMetadata = {
  sessionId?: string;
  title?: string;
  archived?: boolean;
  wireMtime?: number | null;
  cwd?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  lastPrompt?: string;
  agentsHomedir?: string;
};
type KimiMetadataFields = KimiSessionMetadata & {
  archivedPresent: boolean;
  wireMtimePresent: boolean;
};
type KimiContextReadResult = {
  contextPath: string;
  messages: KimiMessage[];
  rawLineCount: number;
  bytes: number;
  droppedRecordCount: number;
  mtime?: Date;
  birthtime?: Date;
};
type KimiWireMetadata = {
  path?: string;
  exists: boolean;
  bytes?: number;
  protocolVersion?: string;
  recordTypes: string[];
};
type KimiWireReadResult = {
  wirePath: string;
  messages: KimiMessage[];
  rawLineCount: number;
  bytes: number;
  droppedRecordCount: number;
  mtime?: Date;
  birthtime?: Date;
  protocolVersion?: string;
  recordTypes: string[];
  model?: string;
  createdAtMs?: number;
  compacted: boolean;
};

type KimiContentBlock = Record<string, unknown> & { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hashWorkDirPath(workDirPath: string): string {
  return createHash('md5').update(workDirPath, 'utf8').digest('hex');
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const parsed: unknown = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch (err) {
    logger.debug('kimi: failed to parse json file', filePath, err);
    return undefined;
  }
}

// ── v2 discovery: session index + workspaces ────────────────────────────────

/**
 * Read the authoritative session index written by Kimi Code v2.
 * Each line is { sessionId, sessionDir, workDir }.
 */
async function readSessionIndex(): Promise<KimiSessionIndexEntry[]> {
  const rows = await readJsonlFile<Record<string, unknown>>(KIMI_SESSION_INDEX_PATH);
  const entries: KimiSessionIndexEntry[] = [];
  for (const row of rows) {
    const sessionDir = stringField(row, 'sessionDir');
    if (!sessionDir) continue;
    entries.push({
      sessionId: stringField(row, 'sessionId'),
      sessionDir,
      workDir: stringField(row, 'workDir'),
    });
  }
  return entries;
}

/**
 * Read workspace roots from workspaces.json: maps the `wd_<name>_<hash>`
 * directory name to the absolute workspace root path.
 */
async function readWorkspaceRoots(): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  const raw = await readJsonObject(KIMI_WORKSPACES_PATH);
  if (!raw) return roots;
  const workspaces = raw.workspaces;
  if (!isRecord(workspaces)) return roots;
  for (const [key, value] of Object.entries(workspaces)) {
    if (!isRecord(value)) continue;
    const root = stringField(value, 'root');
    if (root) roots.set(key, root);
  }
  return roots;
}

/**
 * Find all Kimi session paths. v2 sessions come from the session index
 * (falling back to a `sessions/wd_<name>_<hash>/session_<id>/` scan), legacy
 * sessions from the legacy `~/.kimi/sessions/<md5>/` layout.
 */
async function findSessionPaths(): Promise<KimiSessionPath[]> {
  const results: KimiSessionPath[] = [];
  const seen = new Set<string>();

  for (const entry of await readSessionIndex()) {
    const sessionDir = entry.sessionDir;
    if (!sessionDir || seen.has(sessionDir) || !(await pathExists(sessionDir))) continue;
    seen.add(sessionDir);
    results.push({ path: sessionDir, layout: 'v2', indexEntry: entry });
  }

  // v2 fallback scan: sessions/wd_<name>_<hash>/session_<id>/
  if (await pathExists(KIMI_SESSIONS_DIR)) {
    const workdirDirs = await listSubdirectoriesAsync(KIMI_SESSIONS_DIR);
    for (const workdirDir of workdirDirs) {
      if (!path.basename(workdirDir).startsWith('wd_')) continue;
      const sessionDirs = await listSubdirectoriesAsync(workdirDir);
      for (const sessionDir of sessionDirs) {
        if (seen.has(sessionDir)) continue;
        if (!path.basename(sessionDir).startsWith('session_')) continue;
        if (!(await pathExists(path.join(sessionDir, 'state.json')))) continue;
        seen.add(sessionDir);
        results.push({ path: sessionDir, layout: 'v2' });
      }
    }
  }

  // legacy scan: sessions/<md5(work_dir)>/{<session-id>/, <session-id>.jsonl}
  if (await pathExists(KIMI_LEGACY_SESSIONS_DIR)) {
    const workdirDirs = await listSubdirectoriesAsync(KIMI_LEGACY_SESSIONS_DIR);
    for (const workdirDir of workdirDirs) {
      try {
        const entries = await fs.promises.readdir(workdirDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(workdirDir, entry.name);
          let isDir = entry.isDirectory();
          let isFile = entry.isFile();
          if (entry.isSymbolicLink()) {
            try {
              const stat = await fs.promises.stat(fullPath);
              isDir = stat.isDirectory();
              isFile = stat.isFile();
            } catch {
              continue;
            }
          }
          if (isDir) {
            if (seen.has(fullPath)) continue;
            if (!(await pathExists(path.join(fullPath, 'context.jsonl')))) continue;
            seen.add(fullPath);
            results.push({ path: fullPath, layout: 'legacy' });
          } else if (isFile && fullPath.endsWith('.jsonl') && !seen.has(fullPath)) {
            seen.add(fullPath);
            results.push({ path: fullPath, layout: 'legacy' });
          }
        }
      } catch (err) {
        logger.debug('kimi: cannot read workdir session directory', workdirDir, err);
      }
    }
  }

  return results;
}

// ── v2 metadata: state.json ─────────────────────────────────────────────────

function extractV2MetadataFields(raw: Record<string, unknown>): KimiMetadataFields {
  const title = stringField(raw, 'title');
  let agentsHomedir: string | undefined;
  const agents = raw.agents;
  if (isRecord(agents)) {
    const main = agents.main;
    if (isRecord(main)) agentsHomedir = stringField(main, 'homedir');
  }

  const createdAtMs = numberField(raw, 'createdAt');
  const updatedAtMs = numberField(raw, 'updatedAt');

  return {
    sessionId: stringField(raw, 'id'),
    title: title && title !== 'Untitled' ? title : undefined,
    archived: typeof raw.archived === 'boolean' ? raw.archived === true : undefined,
    cwd: stringField(raw, 'cwd'),
    lastPrompt: stringField(raw, 'lastPrompt'),
    agentsHomedir,
    ...(createdAtMs !== undefined && createdAtMs !== null && createdAtMs > 0 ? { createdAtMs } : {}),
    ...(updatedAtMs !== undefined && updatedAtMs !== null && updatedAtMs > 0 ? { updatedAtMs } : {}),
    archivedPresent: typeof raw.archived === 'boolean',
    wireMtimePresent: false,
  };
}

async function parseV2Metadata(sessionDir: string): Promise<KimiSessionMetadata> {
  const raw = await readJsonObject(path.join(sessionDir, 'state.json'));
  if (!raw) return {};
  return extractV2MetadataFields(raw);
}

/**
 * Resolve the v2 wire log path for a session directory. Prefers the
 * `agents.main.homedir` recorded in state.json, falling back to the
 * conventional `agents/main/wire.jsonl` location.
 */
async function resolveV2WirePath(sessionDir: string, agentsHomedir?: string): Promise<string | undefined> {
  const candidates = [
    agentsHomedir ? path.join(agentsHomedir, 'wire.jsonl') : undefined,
    path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

async function resolveV2Cwd(
  sessionDir: string,
  metadata: KimiSessionMetadata,
  indexEntry: KimiSessionIndexEntry | undefined,
  workspaceRoots: Map<string, string>,
): Promise<string> {
  if (metadata.cwd) return metadata.cwd;
  if (indexEntry?.workDir) return indexEntry.workDir;
  const wdDirName = path.basename(path.dirname(sessionDir));
  return workspaceRoots.get(wdDirName) || '';
}

// ── v2 conversation: agents/main/wire.jsonl (protocol 1.5) ──────────────────

function contentPartOf(record: Record<string, unknown>): { type: string; part: KimiContentBlock } | undefined {
  const event = record.event;
  if (!isRecord(event)) return undefined;
  const eventType = stringField(event, 'type');
  const part = event.part;
  if (eventType !== 'content.part' || !isRecord(part) || typeof part.type !== 'string') return undefined;
  return { type: part.type, part: part as KimiContentBlock };
}

function toolCallOf(record: Record<string, unknown>): { name: string; toolCallId: string; args: unknown } | undefined {
  const event = record.event;
  if (!isRecord(event)) return undefined;
  if (stringField(event, 'type') !== 'tool.call') return undefined;
  const name = stringField(event, 'name');
  const toolCallId = stringField(event, 'toolCallId');
  if (!name || !toolCallId) return undefined;
  return { name, toolCallId, args: event.args };
}

/**
 * Stream a protocol-1.5 wire log once, reconstructing KimiMessage records
 * (user turns, assistant text/think parts, tool calls, usage snapshots) in
 * order while tracking fidelity stats and wire metadata.
 */
async function readWireConversation(wirePath: string): Promise<KimiWireReadResult> {
  const empty: KimiWireReadResult = {
    wirePath,
    messages: [],
    rawLineCount: 0,
    bytes: 0,
    droppedRecordCount: 0,
    recordTypes: [],
    compacted: false,
  };

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(wirePath);
  } catch (err) {
    logger.debug('kimi: failed to stat wire log', wirePath, err);
    return empty;
  }

  if (stats.size === 0) {
    return { ...empty, bytes: 0, mtime: stats.mtime, birthtime: stats.birthtime };
  }

  const messages: KimiMessage[] = [];
  const recordTypes: string[] = [];
  const seenTypes = new Set<string>();
  let protocolVersion: string | undefined;
  let model: string | undefined;
  let createdAtMs: number | undefined;
  let compacted = false;
  let rawLineCount = 0;
  let droppedRecordCount = 0;
  let openAssistant: KimiMessage | undefined;

  const addRecordType = (type: string): void => {
    if (seenTypes.has(type)) return;
    seenTypes.add(type);
    recordTypes.push(type);
  };

  const flushAssistant = (): void => {
    if (!openAssistant) return;
    const hasContent = Array.isArray(openAssistant.content) && openAssistant.content.length > 0;
    const hasCalls = Array.isArray(openAssistant.tool_calls) && openAssistant.tool_calls.length > 0;
    if (hasContent || hasCalls) messages.push(openAssistant);
    openAssistant = undefined;
  };

  const processRecord = (parsed: Record<string, unknown>): void => {
    const type = stringField(parsed, 'type');
    if (!type) {
      droppedRecordCount++;
      return;
    }
    addRecordType(type);

    switch (type) {
      case 'metadata': {
        protocolVersion = stringField(parsed, 'protocol_version') || stringField(parsed, 'protocolVersion');
        const created = numberField(parsed, 'created_at');
        if (created !== undefined && created !== null && created > 0) createdAtMs = created;
        break;
      }
      case 'profile.bind': {
        model ||= stringField(parsed, 'modelAlias');
        break;
      }
      case 'llm.request': {
        model ||= stringField(parsed, 'modelAlias');
        break;
      }
      case 'turn.prompt': {
        const origin = parsed.origin;
        const kind = isRecord(origin) ? stringField(origin, 'kind') : undefined;
        if (kind !== 'user') break;
        flushAssistant();
        const input = parsed.input;
        if (Array.isArray(input)) {
          messages.push({ role: 'user', content: input });
        }
        break;
      }
      case 'context.append_loop_event': {
        const part = contentPartOf(parsed);
        if (part && (part.type === 'text' || part.type === 'think')) {
          addRecordType('content.part');
          openAssistant ??= { role: 'assistant', content: [] };
          (openAssistant.content as KimiContentBlock[]).push(part.part);
          break;
        }
        const call = toolCallOf(parsed);
        if (call) {
          addRecordType('tool.call');
          openAssistant ??= { role: 'assistant', content: [] };
          openAssistant.tool_calls ??= [];
          openAssistant.tool_calls.push({
            type: 'function',
            id: call.toolCallId,
            function: {
              name: call.name,
              arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
            },
          });
        }
        break;
      }
      case 'turn.ended':
        flushAssistant();
        break;
      case 'context.apply_compaction':
      case 'full_compaction.begin':
        compacted = true;
        break;
      case 'usage.record': {
        const usage = parsed.usage;
        if (isRecord(usage)) {
          let total = 0;
          for (const key of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation']) {
            const value = usage[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) total += value;
          }
          if (total > 0) {
            messages.push({ role: '_usage', token_count: total } as unknown as KimiMessage);
          }
        }
        break;
      }
      default:
        break;
    }
  };

  const decoder = new StringDecoder('utf8');
  const stream = fs.createReadStream(wirePath);
  let lineBuffer = '';

  const finishLine = (line: string): void => {
    rawLineCount++;
    if (line.length === 0) {
      droppedRecordCount++;
      return;
    }
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.debug('kimi: skipping invalid JSON line in', wirePath);
      droppedRecordCount++;
      return;
    }
    if (!isRecord(parsed)) {
      logger.debug('kimi: skipping non-object wire record', wirePath);
      droppedRecordCount++;
      return;
    }
    processRecord(parsed);
  };

  try {
    for await (const chunk of stream) {
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      let newlineIndex = text.indexOf('\n', start);
      while (newlineIndex !== -1) {
        lineBuffer += text.slice(start, newlineIndex);
        finishLine(lineBuffer);
        lineBuffer = '';
        start = newlineIndex + 1;
        newlineIndex = text.indexOf('\n', start);
      }
      lineBuffer += text.slice(start);
    }
    const remaining = decoder.end();
    if (remaining.length > 0) lineBuffer += remaining;
    if (lineBuffer.length > 0) {
      finishLine(lineBuffer);
    }
  } catch (err) {
    logger.debug('kimi: failed to read wire log', wirePath, err);
    return empty;
  }

  flushAssistant();

  return {
    wirePath,
    messages,
    rawLineCount,
    bytes: stats.size,
    droppedRecordCount,
    mtime: stats.mtime,
    birthtime: stats.birthtime,
    ...(protocolVersion ? { protocolVersion } : {}),
    recordTypes,
    ...(model ? { model } : {}),
    ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    compacted,
  };
}

// ── legacy metadata + context (pre-0.39 layout) ─────────────────────────────

function extractMetadataFields(raw: Record<string, unknown>): KimiMetadataFields {
  const title = stringField(raw, 'custom_title') || stringField(raw, 'title');
  const wireMtime = numberField(raw, 'wire_mtime');
  const archivedPresent = typeof raw.archived === 'boolean';

  return {
    sessionId: stringField(raw, 'session_id'),
    title: title && title !== 'Untitled' ? title : undefined,
    archived: archivedPresent ? raw.archived === true : undefined,
    ...(wireMtime !== undefined ? { wireMtime } : {}),
    archivedPresent,
    wireMtimePresent: wireMtime !== undefined,
  };
}

function emptyMetadataFields(): KimiMetadataFields {
  return {
    archivedPresent: false,
    wireMtimePresent: false,
  };
}

async function parseSessionMetadata(sessionDir: string): Promise<KimiSessionMetadata> {
  const [legacyRaw, stateRaw] = await Promise.all([
    readJsonObject(path.join(sessionDir, 'metadata.json')),
    readJsonObject(path.join(sessionDir, 'state.json')),
  ]);

  const legacy = legacyRaw ? extractMetadataFields(legacyRaw) : emptyMetadataFields();
  const state = stateRaw ? extractMetadataFields(stateRaw) : emptyMetadataFields();

  return {
    sessionId: state.sessionId || legacy.sessionId,
    title: state.title || legacy.title,
    archived: state.archivedPresent ? state.archived : legacy.archived,
    wireMtime: state.wireMtimePresent ? state.wireMtime : legacy.wireMtime,
  };
}

async function getMetadataCreatedAt(sessionDir: string, fallback: Date): Promise<Date> {
  for (const filename of ['state.json', 'metadata.json']) {
    try {
      const stats = await fs.promises.stat(path.join(sessionDir, filename));
      return stats.birthtime;
    } catch (err) {
      logger.debug('kimi: metadata stats unavailable', sessionDir, filename, err);
    }
  }

  return fallback;
}

/**
 * Read context.jsonl from a legacy Kimi session directory.
 */
async function readContextData(sessionPath: string): Promise<KimiContextReadResult> {
  const contextPath = sessionPath.endsWith('.jsonl') ? sessionPath : path.join(sessionPath, 'context.jsonl');
  const empty: KimiContextReadResult = {
    contextPath,
    messages: [],
    rawLineCount: 0,
    bytes: 0,
    droppedRecordCount: 0,
  };

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(contextPath);
  } catch (err) {
    logger.debug('kimi: failed to stat context', contextPath, err);
    return empty;
  }

  if (stats.size === 0) {
    return { ...empty, bytes: 0, mtime: stats.mtime, birthtime: stats.birthtime };
  }

  const messages: KimiMessage[] = [];
  let rawLineCount = 0;
  let droppedRecordCount = 0;

  const decoder = new StringDecoder('utf8');
  const stream = fs.createReadStream(contextPath);
  let lineBuffer = '';

  const finishLine = (line: string): void => {
    rawLineCount++;
    if (line.length === 0) {
      droppedRecordCount++;
      return;
    }
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.debug('kimi: skipping invalid JSON line in', contextPath);
      droppedRecordCount++;
      return;
    }
    if (!isRecord(parsed)) {
      logger.debug('kimi: skipping non-object context record', contextPath);
      droppedRecordCount++;
      return;
    }
    if (typeof parsed.role !== 'string') {
      logger.debug('kimi: skipping context record with missing role', contextPath);
      droppedRecordCount++;
      return;
    }
    messages.push(parsed as KimiMessage);
  };

  try {
    for await (const chunk of stream) {
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      let newlineIndex = text.indexOf('\n', start);
      while (newlineIndex !== -1) {
        lineBuffer += text.slice(start, newlineIndex);
        finishLine(lineBuffer);
        lineBuffer = '';
        start = newlineIndex + 1;
        newlineIndex = text.indexOf('\n', start);
      }
      lineBuffer += text.slice(start);
    }
    const remaining = decoder.end();
    if (remaining.length > 0) lineBuffer += remaining;
    if (lineBuffer.length > 0) {
      finishLine(lineBuffer);
    }
  } catch (err) {
    logger.debug('kimi: failed to read context', sessionPath, err);
    return empty;
  }

  return {
    contextPath,
    messages,
    rawLineCount,
    bytes: stats.size,
    droppedRecordCount,
    mtime: stats.mtime,
    birthtime: stats.birthtime,
  };
}

async function readWireMetadata(sessionPath: string): Promise<KimiWireMetadata> {
  const sessionDir = sessionPath.endsWith('.jsonl') ? undefined : sessionPath;
  if (!sessionDir) return { exists: false, recordTypes: [] };

  const wirePath = path.join(sessionDir, 'wire.jsonl');
  let bytes: number | undefined;
  try {
    bytes = (await fs.promises.stat(wirePath)).size;
  } catch {
    return { exists: false, path: wirePath, recordTypes: [] };
  }

  const recordTypes: string[] = [];
  let protocolVersion: string | undefined;

  await scanJsonlHead(wirePath, 25, (parsed) => {
    if (!isRecord(parsed)) return 'continue';

    if (parsed.type === 'metadata') {
      protocolVersion = stringField(parsed, 'protocol_version') || stringField(parsed, 'protocolVersion');
    }

    const topLevelType = stringField(parsed, 'type');
    const message = parsed.message;
    const messageType = isRecord(message) ? stringField(message, 'type') : undefined;
    const recordType = messageType || (topLevelType && topLevelType !== 'metadata' ? topLevelType : undefined);
    if (recordType && !recordTypes.includes(recordType)) {
      recordTypes.push(recordType);
    }

    return 'continue';
  });

  return {
    exists: true,
    path: wirePath,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
    recordTypes,
  };
}

// ── shared message extraction ───────────────────────────────────────────────

function getContentBlocks(content: unknown): KimiContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is KimiContentBlock => isRecord(block) && typeof block.type === 'string');
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string' || content === undefined) {
    return extractTextFromBlocks(content);
  }

  const blocks = getContentBlocks(content).map((block) => ({
    type: block.type,
    text: typeof block.text === 'string' ? block.text : undefined,
  }));
  return extractTextFromBlocks(blocks);
}

/**
 * Extract first real user message from Kimi messages
 */
function extractFirstUserMessage(messages: KimiMessage[]): string {
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = extractMessageText(msg.content);
      if (text) return text;
    }
  }
  return '';
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(value);
  return isRecord(parsed) ? parsed : undefined;
}

function escapeJsonStringControlChars(value: string): string {
  let escapedJson = '';
  let insideString = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      escapedJson += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escapedJson += char;
      if (insideString) escaped = true;
      continue;
    }

    if (char === '"') {
      insideString = !insideString;
      escapedJson += char;
      continue;
    }

    const code = char.charCodeAt(0);
    if (insideString && code >= 0 && code <= 0x1f) {
      switch (char) {
        case '\n':
          escapedJson += '\\n';
          break;
        case '\r':
          escapedJson += '\\r';
          break;
        case '\t':
          escapedJson += '\\t';
          break;
        case '\b':
          escapedJson += '\\b';
          break;
        case '\f':
          escapedJson += '\\f';
          break;
        default:
          escapedJson += `\\u${code.toString(16).padStart(4, '0')}`;
      }
      continue;
    }

    escapedJson += char;
  }

  return escapedJson;
}

/**
 * Parse tool call arguments safely
 */
function parseToolArgs(argsValue: unknown): Record<string, unknown> {
  if (typeof argsValue !== 'string' || argsValue.trim().length === 0) {
    return {};
  }

  try {
    return parseJsonObject(argsValue) ?? {};
  } catch (err) {
    logger.debug('kimi: failed to parse tool arguments as strict JSON', err);
  }

  try {
    return parseJsonObject(escapeJsonStringControlChars(argsValue)) ?? {};
  } catch (err) {
    logger.debug('kimi: failed to parse tool arguments after control-char escaping', err);
    return {};
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function getToolCalls(msg: KimiMessage): Array<{ name: string; arguments: unknown }> {
  const rawToolCalls = (msg as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(rawToolCalls)) return [];

  const calls: Array<{ name: string; arguments: unknown }> = [];
  for (const rawCall of rawToolCalls) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function)) continue;
    const name = rawCall.function.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    calls.push({ name, arguments: rawCall.function.arguments });
  }

  return calls;
}

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector
 */
function extractToolData(
  messages: KimiMessage[],
  config?: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;

    for (const tc of getToolCalls(msg)) {
      const name = tc.name;
      const args = parseToolArgs(tc.arguments);
      const category = classifyToolName(name);
      if (!category) continue; // skip internal tools

      const fp = stringArg(args, 'file_path') || stringArg(args, 'path') || '';

      switch (category) {
        case 'write': {
          collector.add(name, fileSummary('write', fp, undefined, false), {
            data: { category: 'write', filePath: fp },
            filePath: fp,
            isWrite: true,
          });
          break;
        }
        case 'read':
          collector.add(name, fileSummary('read', fp), {
            data: { category: 'read', filePath: fp },
            filePath: fp,
          });
          break;
        case 'shell': {
          const cmd = stringArg(args, 'command') || stringArg(args, 'cmd') || '';
          collector.add(name, shellSummary(cmd), {
            data: { category: 'shell', command: cmd },
          });
          break;
        }
        case 'edit': {
          collector.add(name, fileSummary('edit', fp), {
            data: { category: 'edit', filePath: fp },
            filePath: fp,
            isWrite: true,
          });
          break;
        }
        case 'grep': {
          const pattern = stringArg(args, 'pattern') || stringArg(args, 'query') || '';
          collector.add(name, `grep "${truncate(pattern, 40)}"`, {
            data: { category: 'grep', pattern, ...(fp ? { targetPath: fp } : {}) },
          });
          break;
        }
        case 'glob': {
          const pattern = stringArg(args, 'pattern') || fp;
          collector.add(name, `glob ${truncate(pattern, 50)}`, {
            data: { category: 'glob', pattern },
          });
          break;
        }
        case 'search':
          collector.add(name, `search "${truncate(stringArg(args, 'query') || '', 50)}"`, {
            data: { category: 'search', query: stringArg(args, 'query') || '' },
          });
          break;
        case 'fetch':
          collector.add(name, `fetch ${truncate(stringArg(args, 'url') || '', 60)}`, {
            data: { category: 'fetch', url: stringArg(args, 'url') || '' },
          });
          break;
        case 'task': {
          const desc = stringArg(args, 'description') || stringArg(args, 'prompt') || '';
          const agentType = stringArg(args, 'subagent_type');
          collector.add(name, `task "${truncate(desc, 60)}"${agentType ? ` (${agentType})` : ''}`, {
            data: { category: 'task', description: desc, ...(agentType ? { agentType } : {}) },
          });
          break;
        }
        case 'ask': {
          const question = truncate(stringArg(args, 'question') || stringArg(args, 'prompt') || '', 80);
          collector.add(name, `ask: "${question}"`, {
            data: { category: 'ask', question },
          });
          break;
        }
        default: {
          // mcp — fallback to compact format
          const argsStr = Object.keys(args).length > 0 ? JSON.stringify(args).slice(0, 100) : '';
          collector.add(name, mcpSummary(name, argsStr, undefined), {
            data: { category: 'mcp', toolName: name, ...(argsStr ? { params: argsStr } : {}) },
          });
        }
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

function thinkText(block: KimiContentBlock): string | undefined {
  if (block.type !== 'think' || block.think === undefined || block.think === null) return undefined;
  return String(block.think).trim();
}

function normalizedTaskKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract session notes (thinking blocks, token usage)
 */
function extractSessionNotes(messages: KimiMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];
  const reasoningSet = new Set<string>();
  let latestTokenCount = 0;

  for (const msg of messages) {
    // Extract thinking blocks from assistant messages
    if (msg.role === 'assistant') {
      for (const block of getContentBlocks(msg.content)) {
        const thought = thinkText(block);
        if (thought) {
          const key = normalizedTaskKey(thought);
          if (thought.length > 10 && reasoning.length < 5 && !reasoningSet.has(key)) {
            reasoningSet.add(key);
            reasoning.push(truncate(thought, 200));
          }
        }
      }
    }

    // Extract usage info from _usage entries
    if (msg.role === '_usage' && 'token_count' in msg) {
      const tokenCount = (msg as unknown as { token_count?: unknown }).token_count;
      if (typeof tokenCount === 'number' && Number.isFinite(tokenCount) && tokenCount >= 0) {
        latestTokenCount = tokenCount;
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  // Kimi `_usage` records expose token totals rather than input/output splits.
  // Avoid fabricating input/output splits from that total.
  if (latestTokenCount > 0) {
    logger.debug('kimi: latest token_count snapshot', latestTokenCount);
  }

  return notes;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listSubdirectoriesAsync(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const subdirs: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(fullPath);
      } else if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.isDirectory()) subdirs.push(fullPath);
        } catch {
          // broken symlink — skip
        }
      }
    }
    return subdirs;
  } catch (err) {
    logger.debug('kimi: cannot list subdirectories of', dir, err);
    return [];
  }
}

// ── legacy work-dir hash index ──────────────────────────────────────────────

async function parseKimiWorkDirs(): Promise<KimiWorkDirEntry[]> {
  try {
    const raw = await readJsonObject(KIMI_CONFIG_PATH);
    if (!raw) return [];
    const workDirs = Array.isArray(raw.work_dirs) ? raw.work_dirs : [];

    return workDirs
      .map((item) => {
        if (typeof item === 'string') return { path: item };
        if (!item || typeof item !== 'object') return null;
        const candidate = item as { path?: unknown; kaos?: unknown };
        if (typeof candidate.path !== 'string' || candidate.path.length === 0) return null;
        return {
          path: candidate.path,
          kaos: typeof candidate.kaos === 'string' && candidate.kaos.length > 0 ? candidate.kaos : undefined,
        };
      })
      .filter((entry): entry is KimiWorkDirEntry => entry !== null);
  } catch (err) {
    logger.debug('kimi: failed to parse kimi.json work_dirs', err);
    return [];
  }
}

function buildWorkDirHashIndex(workDirs: KimiWorkDirEntry[]): Map<string, string> {
  const hashIndex = new Map<string, string>();

  for (const wd of workDirs) {
    const md5 = hashWorkDirPath(wd.path);
    const keys = [md5];

    // Kimi can prefix non-local KAOS sessions as "{kaos}_{md5}".
    if (wd.kaos && wd.kaos.toLowerCase() !== 'local') {
      keys.push(`${wd.kaos}_${md5}`);
    }

    for (const key of keys) {
      if (!hashIndex.has(key)) {
        hashIndex.set(key, wd.path);
      }
    }
  }

  return hashIndex;
}

function resolveCwdFromSessionDir(sessionDir: string, hashIndex: Map<string, string>): string {
  const workDirHash = path.basename(path.dirname(sessionDir));
  return hashIndex.get(workDirHash) || '';
}

function deriveSessionId(sessionPath: string): string {
  if (sessionPath.endsWith('.jsonl')) {
    return path.basename(sessionPath, '.jsonl');
  }
  return path.basename(sessionPath);
}

// ── session listing ─────────────────────────────────────────────────────────

/**
 * Parse all Kimi sessions (v2 `~/.kimi-code` layout with legacy fallback).
 */
export async function parseKimiSessions(): Promise<UnifiedSession[]> {
  const sessionPaths = await findSessionPaths();
  const sessions: UnifiedSession[] = [];
  const workspaceRoots = await readWorkspaceRoots();
  const legacyWorkDirHashIndex = buildWorkDirHashIndex(await parseKimiWorkDirs());

  for (const candidate of sessionPaths) {
    try {
      const session =
        candidate.layout === 'v2'
          ? await buildV2Session(candidate, workspaceRoots)
          : await buildLegacySession(candidate, legacyWorkDirHashIndex);
      if (session) sessions.push(session);
    } catch (err) {
      logger.debug('kimi: skipping unparseable session', candidate.path, err);
      // Skip sessions we can't parse
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

async function buildV2Session(
  candidate: KimiSessionPath,
  workspaceRoots: Map<string, string>,
): Promise<UnifiedSession | undefined> {
  const sessionDir = candidate.path;
  const metadata = await parseV2Metadata(sessionDir);
  if (metadata.archived === true) return undefined;
  const sessionId = metadata.sessionId || deriveSessionId(sessionDir);
  if (!sessionId) return undefined;

  const wirePath = await resolveV2WirePath(sessionDir, metadata.agentsHomedir);
  if (!wirePath) return undefined;
  const wireData = await readWireConversation(wirePath);
  if (wireData.messages.length === 0) return undefined;
  if (!wireData.mtime || !wireData.birthtime) return undefined;

  const firstUserMessage = extractFirstUserMessage(wireData.messages);
  const cwd = await resolveV2Cwd(sessionDir, metadata, candidate.indexEntry, workspaceRoots);
  const repo = extractRepoFromCwd(cwd);

  let createdAt = wireData.mtime;
  if (metadata.createdAtMs !== undefined) {
    createdAt = new Date(metadata.createdAtMs);
  } else if (wireData.createdAtMs !== undefined) {
    createdAt = new Date(wireData.createdAtMs);
  }

  let updatedAt = wireData.mtime;
  if (metadata.updatedAtMs !== undefined) {
    updatedAt = new Date(metadata.updatedAtMs);
  }

  const summary = cleanSummary(firstUserMessage) || metadata.title || undefined;

  return {
    id: sessionId,
    source: 'kimi',
    cwd,
    repo,
    lines: wireData.rawLineCount,
    bytes: wireData.bytes,
    createdAt,
    updatedAt,
    originalPath: sessionDir,
    summary: summary || cleanSummary(metadata.lastPrompt || '') || undefined,
    ...(wireData.model ? { model: wireData.model } : {}),
  };
}

async function buildLegacySession(
  candidate: KimiSessionPath,
  legacyWorkDirHashIndex: Map<string, string>,
): Promise<UnifiedSession | undefined> {
  const sessionPath = candidate.path;
  const metadataDir = sessionPath.endsWith('.jsonl') ? undefined : sessionPath;
  const metadata = metadataDir ? await parseSessionMetadata(metadataDir) : {};
  if (metadata.archived === true) return undefined;
  const sessionId = metadata.sessionId || deriveSessionId(sessionPath);
  if (!sessionId) return undefined;

  const contextData = await readContextData(sessionPath);
  if (contextData.messages.length === 0) return undefined;
  if (!contextData.mtime || !contextData.birthtime) return undefined;

  const firstUserMessage = extractFirstUserMessage(contextData.messages);
  const summary = cleanSummary(firstUserMessage);

  const cwd = resolveCwdFromSessionDir(sessionPath, legacyWorkDirHashIndex);
  const repo = extractRepoFromCwd(cwd);

  let updatedAt = contextData.mtime;
  if (metadata.wireMtime !== null && metadata.wireMtime !== undefined && metadata.wireMtime > 0) {
    const wireUpdatedAt = new Date(metadata.wireMtime * 1000);
    if (!Number.isNaN(wireUpdatedAt.getTime())) {
      updatedAt = wireUpdatedAt;
    }
  }

  return {
    id: sessionId,
    source: 'kimi',
    cwd,
    repo,
    lines: contextData.rawLineCount,
    bytes: contextData.bytes,
    createdAt: metadataDir ? await getMetadataCreatedAt(metadataDir, contextData.birthtime) : contextData.birthtime,
    updatedAt,
    originalPath: sessionPath,
    summary: summary || metadata.title || undefined,
  };
}

// ── context extraction ──────────────────────────────────────────────────────

/**
 * Extract context from a Kimi session for cross-tool continuation
 */
export async function extractKimiContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');

  const metadataDir = session.originalPath.endsWith('.jsonl') ? undefined : session.originalPath;
  const v2Metadata = metadataDir ? await parseV2Metadata(metadataDir) : {};
  const v2WirePath = metadataDir ? await resolveV2WirePath(metadataDir, v2Metadata.agentsHomedir) : undefined;

  let messages: KimiMessage[];
  let contextData: KimiContextReadResult | undefined;
  let wireData: KimiWireReadResult | undefined;
  let wireMetadata: KimiWireMetadata | undefined;
  let legacyMode = false;

  if (v2WirePath) {
    wireData = await readWireConversation(v2WirePath);
    messages = wireData.messages;
  } else {
    legacyMode = true;
    contextData = await readContextData(session.originalPath);
    messages = contextData.messages;
    wireMetadata = await readWireMetadata(session.originalPath);
  }

  const recentMessages: ConversationMessage[] = [];
  const pendingTasks: string[] = [];
  const pendingTaskSet = new Set<string>();

  const toolData = extractToolData(messages, resolvedConfig);
  const sessionNotes = extractSessionNotes(messages);

  const sourceMetadata: Record<string, unknown> = {
    shareDir: KIMI_SHARE_DIR,
  };

  if (legacyMode) {
    if (contextData) {
      sourceMetadata.contextPath = contextData.contextPath;
      sourceMetadata.contextLines = contextData.rawLineCount;
      sourceMetadata.contextBytes = contextData.bytes;
      if (contextData.droppedRecordCount > 0) {
        sourceMetadata.contextDroppedRecords = contextData.droppedRecordCount;
      }
    }
    if (metadataDir && (await pathExists(path.join(metadataDir, 'state.json')))) {
      sourceMetadata.statePath = path.join(metadataDir, 'state.json');
    }
    if (metadataDir && (await pathExists(path.join(metadataDir, 'metadata.json')))) {
      sourceMetadata.legacyMetadataPath = path.join(metadataDir, 'metadata.json');
    }
    if (wireMetadata?.path) {
      sourceMetadata.wirePath = wireMetadata.path;
    }
    if (wireMetadata?.protocolVersion) {
      sourceMetadata.wireProtocolVersion = wireMetadata.protocolVersion;
    }
    if (wireMetadata && wireMetadata.recordTypes.length > 0) {
      sourceMetadata.wireRecordTypes = wireMetadata.recordTypes;
    }
    if (wireMetadata?.bytes !== undefined) {
      sourceMetadata.wireBytes = wireMetadata.bytes;
    }
  } else if (wireData) {
    sourceMetadata.wirePath = wireData.wirePath;
    sourceMetadata.wireLines = wireData.rawLineCount;
    sourceMetadata.wireBytes = wireData.bytes;
    if (wireData.droppedRecordCount > 0) {
      sourceMetadata.wireDroppedRecords = wireData.droppedRecordCount;
    }
    if (wireData.protocolVersion) {
      sourceMetadata.wireProtocolVersion = wireData.protocolVersion;
    }
    if (wireData.recordTypes.length > 0) {
      sourceMetadata.wireRecordTypes = wireData.recordTypes;
    }
    if (metadataDir && (await pathExists(path.join(metadataDir, 'state.json')))) {
      sourceMetadata.statePath = path.join(metadataDir, 'state.json');
    }
    if (v2Metadata.agentsHomedir) {
      sourceMetadata.agentsMainDir = v2Metadata.agentsHomedir;
    }
    if (await pathExists(KIMI_SESSION_INDEX_PATH)) {
      sourceMetadata.sessionIndexPath = KIMI_SESSION_INDEX_PATH;
    }
    if (await pathExists(KIMI_WORKSPACES_PATH)) {
      sourceMetadata.workspacesPath = KIMI_WORKSPACES_PATH;
    }
  }

  sessionNotes.sourceMetadata = { ...(sessionNotes.sourceMetadata ?? {}), ...sourceMetadata };
  sessionNotes.rawAccess = {
    kind: metadataDir ? 'directory' : 'file',
    path: metadataDir || session.originalPath,
    redacted: true,
  };

  const fidelityWarnings: string[] = [];
  if (!session.cwd) {
    fidelityWarnings.push(
      'Kimi cwd/repo could not be resolved because no state.json cwd, session index entry, or workspace root matched.',
    );
  }
  if (legacyMode) {
    if (!metadataDir) {
      fidelityWarnings.push('Kimi legacy flat JSONL session has no state.json or wire.jsonl sidecar metadata.');
    } else if (!wireMetadata?.exists) {
      fidelityWarnings.push('Kimi wire.jsonl was not present; wire protocol metadata is unavailable.');
    }
    if (contextData && contextData.droppedRecordCount > 0) {
      fidelityWarnings.push(
        `Kimi context.jsonl contained ${contextData.droppedRecordCount} malformed or unsupported record(s) that were skipped.`,
      );
    }
  } else if (wireData) {
    if (!wireData.protocolVersion) {
      fidelityWarnings.push('Kimi wire.jsonl has no metadata header; wire protocol metadata is unavailable.');
    }
    if (wireData.droppedRecordCount > 0) {
      fidelityWarnings.push(
        `Kimi wire.jsonl contained ${wireData.droppedRecordCount} malformed or unsupported record(s) that were skipped.`,
      );
    }
    if (wireData.compacted) {
      fidelityWarnings.push(
        'Kimi wire.jsonl records a full context compaction; earlier turns may be summarized by the tool.',
      );
    }
  }
  if (fidelityWarnings.length > 0) {
    sessionNotes.fidelityWarnings = [...(sessionNotes.fidelityWarnings ?? []), ...fidelityWarnings];
  }

  // Extract recent conversation messages
  let messageCount = 0;
  for (let i = messages.length - 1; i >= 0 && messageCount < resolvedConfig.recentMessages * 2; i--) {
    const msg = messages[i];

    if (msg.role === 'user') {
      const content = extractMessageText(msg.content);
      if (content) {
        recentMessages.unshift({
          role: 'user',
          content,
        });
        messageCount++;
      }
    } else if (msg.role === 'assistant') {
      const content = extractMessageText(msg.content);
      if (content) {
        recentMessages.unshift({
          role: 'assistant',
          content,
        });
        messageCount++;
      }

      // Extract pending tasks from thinking blocks
      if (pendingTasks.length < 5) {
        for (const block of getContentBlocks(msg.content)) {
          const taskText = thinkText(block);
          if (taskText) {
            const taskKey = normalizedTaskKey(taskText);
            if (
              taskKey.includes('need to') ||
              taskKey.includes('next step') ||
              taskKey.includes('todo') ||
              taskKey.includes('remaining')
            ) {
              if (!pendingTaskSet.has(taskKey)) {
                pendingTaskSet.add(taskKey);
                pendingTasks.push(taskText);
              }
            }
          }
        }
      }
    }
  }

  const trimmed = trimMessages(recentMessages, resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    toolData.filesModified,
    pendingTasks.slice(0, 5),
    toolData.summaries,
    sessionNotes,
    resolvedConfig,
  );

  return {
    session,
    recentMessages: trimmed,
    filesModified: toolData.filesModified,
    pendingTasks: pendingTasks.slice(0, 5),
    toolSummaries: toolData.summaries,
    sessionNotes,
    markdown,
  };
}

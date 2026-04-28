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
import { scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import { fileSummary, mcpSummary, SummaryCollector, shellSummary, truncate } from '../utils/tool-summarizer.js';

function getKimiShareDir(): string {
  const configured = process.env.KIMI_SHARE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir(), '.kimi');
}

const KIMI_SHARE_DIR = getKimiShareDir();
const KIMI_SESSIONS_DIR = path.join(KIMI_SHARE_DIR, 'sessions');
const KIMI_CONFIG_PATH = path.join(KIMI_SHARE_DIR, 'kimi.json');

type KimiWorkDirEntry = { path: string; kaos?: string };
type KimiSessionMetadata = {
  sessionId?: string;
  title?: string;
  archived?: boolean;
  wireMtime?: number | null;
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

function resolveContextPath(sessionPath: string): string {
  return sessionPath.endsWith('.jsonl') ? sessionPath : path.join(sessionPath, 'context.jsonl');
}

function deriveSessionId(sessionPath: string): string {
  if (sessionPath.endsWith('.jsonl')) {
    return path.basename(sessionPath, '.jsonl');
  }
  return path.basename(sessionPath);
}

async function getSessionMetadataDir(sessionPath: string): Promise<string | undefined> {
  try {
    const stats = await fs.promises.stat(sessionPath);
    return stats.isDirectory() ? sessionPath : undefined;
  } catch {
    return undefined;
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find all Kimi session directories and legacy flat context files.
 */
async function findSessionPaths(): Promise<string[]> {
  if (!(await pathExists(KIMI_SESSIONS_DIR))) {
    return [];
  }

  const results: string[] = [];

  // Kimi stores sessions as: ~/.kimi/sessions/{workdir_hash}/{session_id}/
  const workdirDirs = await listSubdirectoriesAsync(KIMI_SESSIONS_DIR);
  for (const workdirDir of workdirDirs) {
    try {
      const entries = await fs.promises.readdir(workdirDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(workdirDir, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          // Directory or symlink (covers symlinked dirs and symlinked flat files).
          // For symlinks, follow once via stat to decide which branch applies.
          let isDir = entry.isDirectory();
          let isFile = false;
          if (entry.isSymbolicLink()) {
            try {
              const stat = await fs.promises.stat(fullPath);
              isDir = stat.isDirectory();
              isFile = stat.isFile();
            } catch {
              continue; // broken symlink — skip
            }
          }
          if (isDir) {
            const contextPath = path.join(fullPath, 'context.jsonl');
            if (await pathExists(contextPath)) {
              results.push(fullPath);
            }
          } else if (isFile && fullPath.endsWith('.jsonl')) {
            results.push(fullPath);
          }
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(fullPath);
        }
      }
    } catch (err) {
      logger.debug('kimi: cannot read workdir session directory', workdirDir, err);
    }
  }

  return results;
}

/**
 * Parse legacy metadata.json and current state.json from a Kimi session directory.
 */
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
 * Read context.jsonl from a Kimi session directory.
 *
 * Single-pass implementation: streams the file once, counts every newline-
 * terminated line (including malformed ones), parses each line as JSON, and
 * tracks dropped records for fidelity reporting. Uses a single async stat to
 * obtain bytes/mtime/birthtime. Avoids the previous double-scan approach
 * (readJsonlFile + getFileStats) which streamed the same file twice.
 */
async function readContextData(sessionPath: string): Promise<KimiContextReadResult> {
  const contextPath = resolveContextPath(sessionPath);
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
  const sessionDir = await getSessionMetadataDir(sessionPath);
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
  // Kimi `_usage` only provides a cumulative token_count total.
  // Avoid fabricating input/output splits from that total.
  if (latestTokenCount > 0) {
    logger.debug('kimi: latest token_count snapshot', latestTokenCount);
  }

  return notes;
}

/**
 * Parse all Kimi sessions
 */
export async function parseKimiSessions(): Promise<UnifiedSession[]> {
  const sessionPaths = await findSessionPaths();
  const sessions: UnifiedSession[] = [];
  const workDirHashIndex = buildWorkDirHashIndex(await parseKimiWorkDirs());

  for (const sessionPath of sessionPaths) {
    try {
      const metadataDir = await getSessionMetadataDir(sessionPath);
      const metadata = metadataDir ? await parseSessionMetadata(metadataDir) : {};
      if (metadata.archived === true) continue;
      const sessionId = metadata.sessionId || deriveSessionId(sessionPath);
      if (!sessionId) continue;

      const contextData = await readContextData(sessionPath);
      if (contextData.messages.length === 0) continue;
      // readContextData supplies mtime/birthtime from a single async stat, so we
      // don't need a separate fs.statSync(contextPath) here.
      if (!contextData.mtime || !contextData.birthtime) continue;

      const firstUserMessage = extractFirstUserMessage(contextData.messages);
      const summary = cleanSummary(firstUserMessage);

      const cwd = resolveCwdFromSessionDir(sessionPath, workDirHashIndex);
      const repo = extractRepoFromCwd(cwd);

      let updatedAt = contextData.mtime;
      if (metadata.wireMtime !== null && metadata.wireMtime !== undefined && metadata.wireMtime > 0) {
        const wireUpdatedAt = new Date(metadata.wireMtime * 1000);
        if (!Number.isNaN(wireUpdatedAt.getTime())) {
          updatedAt = wireUpdatedAt;
        }
      }

      sessions.push({
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
      });
    } catch (err) {
      logger.debug('kimi: skipping unparseable session', sessionPath, err);
      // Skip sessions we can't parse
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Kimi session for cross-tool continuation
 */
export async function extractKimiContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const contextData = await readContextData(session.originalPath);
  const messages = contextData.messages;
  const recentMessages: ConversationMessage[] = [];
  const pendingTasks: string[] = [];
  const pendingTaskSet = new Set<string>();

  const toolData = extractToolData(messages, resolvedConfig);
  const sessionNotes = extractSessionNotes(messages);
  const wireMetadata = await readWireMetadata(session.originalPath);
  const metadataDir = await getSessionMetadataDir(session.originalPath);
  const statePath = metadataDir ? path.join(metadataDir, 'state.json') : undefined;
  const legacyMetadataPath = metadataDir ? path.join(metadataDir, 'metadata.json') : undefined;
  const sourceMetadata: Record<string, unknown> = {
    shareDir: KIMI_SHARE_DIR,
    contextPath: contextData.contextPath,
    contextLines: contextData.rawLineCount,
    contextBytes: contextData.bytes,
  };
  if (contextData.droppedRecordCount > 0) {
    sourceMetadata.contextDroppedRecords = contextData.droppedRecordCount;
  }
  if (statePath && (await pathExists(statePath))) {
    sourceMetadata.statePath = statePath;
  }
  if (legacyMetadataPath && (await pathExists(legacyMetadataPath))) {
    sourceMetadata.legacyMetadataPath = legacyMetadataPath;
  }
  if (wireMetadata.path) {
    sourceMetadata.wirePath = wireMetadata.path;
  }
  if (wireMetadata.protocolVersion) {
    sourceMetadata.wireProtocolVersion = wireMetadata.protocolVersion;
  }
  if (wireMetadata.recordTypes.length > 0) {
    sourceMetadata.wireRecordTypes = wireMetadata.recordTypes;
  }
  if (wireMetadata.bytes !== undefined) {
    sourceMetadata.wireBytes = wireMetadata.bytes;
  }

  sessionNotes.sourceMetadata = { ...(sessionNotes.sourceMetadata ?? {}), ...sourceMetadata };
  sessionNotes.rawAccess = {
    kind: metadataDir ? 'directory' : 'file',
    path: metadataDir || contextData.contextPath,
    redacted: true,
  };

  const fidelityWarnings: string[] = [];
  if (!session.cwd) {
    fidelityWarnings.push('Kimi cwd/repo could not be resolved because the workdir hash was not found in kimi.json.');
  }
  if (!metadataDir) {
    fidelityWarnings.push('Kimi legacy flat JSONL session has no state.json or wire.jsonl sidecar metadata.');
  } else if (!wireMetadata.exists) {
    fidelityWarnings.push('Kimi wire.jsonl was not present; wire protocol metadata is unavailable.');
  }
  if (contextData.droppedRecordCount > 0) {
    fidelityWarnings.push(
      `Kimi context.jsonl contained ${contextData.droppedRecordCount} malformed or unsupported record(s) that were skipped.`,
    );
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

import * as fs from 'node:fs';
import * as path from 'node:path';
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
import type { QwenChatRecord, QwenContent, QwenFileDiff, QwenPart } from '../types/schemas.js';
import { QwenChatRecordSchema } from '../types/schemas.js';
import { classifyToolName } from '../types/tool-names.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { scanJsonlLines } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { fileSummary, mcpSummary, SummaryCollector, shellSummary, truncate } from '../utils/tool-summarizer.js';

// Qwen Code stores chats under <runtime-base>/projects/<sanitized-cwd>/chats/<sessionId>.jsonl.
//
// Runtime base resolution mirrors upstream Qwen Code
// (packages/core/src/config/storage.ts: Storage.getRuntimeBaseDir):
//   1. QWEN_RUNTIME_DIR env var (canonical Qwen override)
//   2. ~/.qwen (Storage.getGlobalQwenDir fallback)
// QWEN_HOME is a continues-side override (no upstream equivalent) for
// fixtures and sandboxed installs that want to redirect lookups at a custom
// home dir without touching real user data. We treat its value as a home dir
// (joining `.qwen` when not already terminated by it).
//
// cwd sanitization mirrors upstream sanitizeCwd
// (packages/core/src/utils/paths.ts:243): replace /[^a-zA-Z0-9]/g with `-`,
// lowercased on Windows. Tests rely on the same scheme so fixture writes and
// parser reads stay in lockstep.

const MAX_QWEN_JSONL_RECORD_CHARS = 16 * 1024 * 1024;

interface ToolResponseInfo {
  name: string;
  output?: string;
  status?: string;
  callId?: string;
}

interface ToolResponses {
  byCallId: Map<string, ToolResponseInfo>;
  byParentName: Map<string, ToolResponseInfo[]>;
}

interface ParentFunctionCall {
  name: string;
  args?: Record<string, unknown>;
  category?: ReturnType<typeof classifyToolName>;
  filePath?: string;
  callId?: string;
}

interface ConfirmedDiffRefs {
  byCallId: Set<string>;
  byParentName: Set<string>;
}

interface QwenSessionMeta {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  summary?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  model?: string;
  lineCount: number;
  bytes: number;
  mtime: Date;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveConfiguredDir(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === '~') return homeDir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homeDir(), value.slice(2));
  }
  return path.isAbsolute(value) ? value : path.resolve(value);
}

function getQwenRuntimeBaseDir(): string {
  const runtimeDir = resolveConfiguredDir(process.env.QWEN_RUNTIME_DIR);
  if (runtimeDir) return runtimeDir;

  const qwenHome = resolveConfiguredDir(process.env.QWEN_HOME);
  if (qwenHome) {
    return path.basename(qwenHome) === '.qwen' ? qwenHome : path.join(qwenHome, '.qwen');
  }

  return path.join(homeDir(), '.qwen');
}

function getQwenProjectsDir(): string {
  return path.join(getQwenRuntimeBaseDir(), 'projects');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function getBooleanField(value: unknown, field: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === 'boolean' ? fieldValue : undefined;
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.debug('qwen-code: failed to stringify JSON value', err);
    return undefined;
  }
}

/** Type guard: is resultDisplay a FileDiff object (not a string or todo)? */
function isFileDiff(rd: unknown): rd is QwenFileDiff {
  if (!rd || typeof rd !== 'object') return false;
  return 'fileName' in rd || 'fileDiff' in rd;
}

/** Parse a timestamp string defensively, falling back to a given Date */
function parseTimestamp(ts: string | undefined, fallback: Date): Date {
  if (!ts) return fallback;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function parseQwenChatRecord(parsed: unknown, filePath: string, lineIndex: number): QwenChatRecord | undefined {
  const result = QwenChatRecordSchema.safeParse(parsed);
  if (result.success) return result.data;
  logger.debug('qwen-code: skipping invalid record at index', lineIndex, 'in', filePath);
  return undefined;
}

function getToolFilePath(args: Record<string, unknown> | undefined): string | undefined {
  return getStringField(args, 'file_path') ?? getStringField(args, 'path') ?? getStringField(args, 'filePath');
}

function getCallId(value: unknown): string | undefined {
  return (
    getStringField(value, 'id') ??
    getStringField(value, 'callId') ??
    getStringField(value, 'call_id') ??
    getStringField(value, 'toolCallId')
  );
}

function responseKey(parentUuid: string, name: string): string {
  return `${parentUuid}\u0000${name}`;
}

function isToolResultError(status: string | undefined): boolean {
  return status ? !['ok', 'success', 'completed'].includes(status.toLowerCase()) : false;
}

// ── JSONL reading ───────────────────────────────────────────────────────────

/**
 * Recover top-level JSON objects from a single physical JSONL line, even when
 * Qwen Code has glued multiple records together (rare runtime races) or
 * truncated one mid-write.
 *
 * **Scope: top-level objects only.** Upstream Qwen Code writes one
 * `ChatRecord` object per line via `chatRecordingService.ts` (which calls
 * `jsonl.writeLine`/`writeLineSync` with a single `ChatRecord`). It never
 * writes top-level arrays, scalars, or non-object records. Anything that is
 * not a `{ ... }` object — bare arrays, strings, numbers, garbage between
 * records — is intentionally skipped by this splitter so a corrupt fragment
 * cannot spoof a record. If upstream ever changes the on-disk shape, this
 * function has to be updated explicitly; the existing test
 * `'silently skips top-level arrays and scalars while keeping intervening objects'`
 * pins the contract.
 *
 * Recovery semantics: scan forward looking for `{`, track string/escape
 * state, balance `{`/`}`. If the running object never closes (truncated
 * write, unterminated string), skip past the failed `{` and keep scanning
 * for later valid objects on the same line — preventing a single garbled
 * fragment from poisoning trailing valid records glued onto the same line.
 */
function splitJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let start: number | undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closedAt: number | undefined;

    for (let index = cursor; index < text.length; index++) {
      const char = text[index];

      if (start === undefined) {
        // Skip whitespace and any garbage (incl. top-level arrays/scalars)
        // before the next opening brace. See block comment above.
        if (char !== '{') continue;
        start = index;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        depth++;
        continue;
      }

      if (char === '}') {
        depth--;
        if (depth === 0) {
          closedAt = index;
          objects.push(text.slice(start, index + 1));
          break;
        }
      }
    }

    if (closedAt !== undefined) {
      cursor = closedAt + 1;
      continue;
    }

    // The trailing object never closed (unterminated string or missing brace).
    // Skip past the failed opening brace and try to recover later top-level
    // objects on the same line. If no opening brace was found at all, stop.
    if (start === undefined) break;
    cursor = start + 1;
  }

  return objects;
}

async function scanQwenJsonlFile(
  filePath: string,
  visitor: (parsed: unknown, lineIndex: number) => 'continue' | 'stop',
): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  await scanJsonlLines(
    filePath,
    (line, lineIndex) => {
      const chunks = splitJsonObjects(line);
      if (chunks.length === 0 && line.trim()) {
        logger.debug('qwen-code: skipping malformed JSONL line at index', lineIndex, 'in', filePath);
      }
      for (const chunk of chunks) {
        try {
          if (visitor(JSON.parse(chunk), lineIndex) === 'stop') return 'stop';
        } catch (err) {
          logger.debug('qwen-code: skipping invalid JSON object at index', lineIndex, 'in', filePath, err);
        }
      }
      return 'continue';
    },
    { maxLineChars: MAX_QWEN_JSONL_RECORD_CHARS },
  );
}

async function readJsonlRecords(filePath: string): Promise<QwenChatRecord[]> {
  const records: QwenChatRecord[] = [];
  await scanQwenJsonlFile(filePath, (parsed, lineIndex) => {
    const record = parseQwenChatRecord(parsed, filePath, lineIndex);
    if (record) records.push(record);
    return 'continue';
  });
  return records;
}

function extractCustomTitle(record: QwenChatRecord): string | undefined {
  if (record.type !== 'system' || record.subtype !== 'custom_title') return undefined;
  return getStringField(isRecord(record) ? record.systemPayload : undefined, 'customTitle');
}

function extractFunctionResponseOutput(part: QwenPart): string | undefined {
  const response = part.functionResponse?.response;
  return (
    getStringField(response, 'output') ??
    stringifyValue(isRecord(response) ? response.result : undefined) ??
    stringifyValue(isRecord(response) ? response.content : undefined)
  );
}

function extractFunctionResponseStatus(part: QwenPart): string | undefined {
  return getStringField(part.functionResponse?.response, 'status');
}

function getFunctionResponseCallId(part: QwenPart): string | undefined {
  return getCallId(part.functionResponse) ?? getCallId(part.functionResponse?.response);
}

function collectToolResponses(records: QwenChatRecord[]): ToolResponses {
  const byCallId = new Map<string, ToolResponseInfo>();
  const byParentName = new Map<string, ToolResponseInfo[]>();

  for (const record of records) {
    if (record.type !== 'tool_result' || !record.parentUuid || !record.message?.parts) continue;

    for (const part of record.message.parts) {
      const name = part.functionResponse?.name;
      if (!name) continue;
      const response: ToolResponseInfo = {
        name,
        output: extractFunctionResponseOutput(part),
        status: extractFunctionResponseStatus(part),
        callId: getFunctionResponseCallId(part) ?? getCallId(record.toolCallResult),
      };
      if (response.callId) byCallId.set(response.callId, response);

      const key = responseKey(record.parentUuid, name);
      const responsesForParent = byParentName.get(key) ?? [];
      responsesForParent.push(response);
      byParentName.set(key, responsesForParent);
    }
  }

  return { byCallId, byParentName };
}

function collectParentFunctionCalls(records: QwenChatRecord[]): Map<string, ParentFunctionCall[]> {
  const callsByParent = new Map<string, ParentFunctionCall[]>();

  for (const record of records) {
    if (record.type !== 'assistant' || !record.message?.parts) continue;

    const calls: ParentFunctionCall[] = [];
    for (const part of record.message.parts) {
      if (!part.functionCall) continue;
      const { name, args } = part.functionCall;
      calls.push({
        name,
        args,
        category: classifyToolName(name),
        filePath: getToolFilePath(args),
        callId: getCallId(part.functionCall),
      });
    }

    if (calls.length > 0) {
      // Merge across duplicate-UUID assistant fragments so earlier function
      // calls aren't overwritten when the same record id is appended to the
      // log multiple times.
      const existing = callsByParent.get(record.uuid);
      callsByParent.set(record.uuid, existing ? [...existing, ...calls] : calls);
    }
  }

  return callsByParent;
}

function findParentFunctionCall(
  callsByParent: Map<string, ParentFunctionCall[]>,
  record: QwenChatRecord,
  displayName: string | undefined,
): ParentFunctionCall | undefined {
  if (!record.parentUuid) return undefined;
  const calls = callsByParent.get(record.parentUuid);
  if (!calls || calls.length === 0) return undefined;

  const resultCallId = getCallId(record.toolCallResult);
  if (resultCallId) {
    const byId = calls.find((call) => call.callId === resultCallId);
    if (byId) return byId;
  }

  if (!displayName) return undefined;

  const byName = calls.filter((call) => call.name === displayName);
  if (byName.length === 1) return byName[0];

  const displayCategory = classifyToolName(displayName);
  const byCategory = calls.filter((call) => call.category === displayCategory);
  return byCategory.length === 1 ? byCategory[0] : undefined;
}

// ── Text extraction ─────────────────────────────────────────────────────────

/** Extract non-thought text from parts */
function extractTextFromParts(parts: QwenPart[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text!)
    .join('\n');
}

/** Extract thought/reasoning text from parts */
function extractThoughtsFromParts(parts: QwenPart[] | undefined): string[] {
  if (!parts) return [];
  return parts.filter((p) => p.text && p.thought).map((p) => p.text!);
}

function extractContentText(content: QwenContent | undefined): string {
  if (!content?.parts) return '';
  return extractTextFromParts(content.parts);
}

// ── Session file discovery ──────────────────────────────────────────────────

async function findSessionFiles(): Promise<string[]> {
  const results: string[] = [];
  const qwenProjectsDir = getQwenProjectsDir();

  if (!fs.existsSync(qwenProjectsDir)) return results;

  for (const projectDir of listSubdirectories(qwenProjectsDir)) {
    const chatsDir = path.join(projectDir, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    try {
      const entries = fs.readdirSync(chatsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(path.join(chatsDir, entry.name));
        }
      }
    } catch (err) {
      logger.debug('qwen-code: error reading chats dir', chatsDir, err);
    }
  }

  return results;
}

// ── Session metadata extraction ─────────────────────────────────────────────

async function extractSessionMeta(filePath: string): Promise<QwenSessionMeta | null> {
  // One async stat covers both bytes and mtime, replacing two synchronous
  // statSync calls on the parser hot path.
  let fileStat: fs.Stats;
  try {
    fileStat = await fs.promises.stat(filePath);
  } catch (err) {
    logger.debug('qwen-code: failed to stat session file', filePath, err);
    return null;
  }

  let sessionId = '';
  let cwd = '';
  let gitBranch: string | undefined;
  let firstUserMessage = '';
  let customTitle: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let model: string | undefined;
  let lineCount = 0;

  await scanJsonlLines(
    filePath,
    (line, lineIndex) => {
      lineCount = lineIndex + 1;
      const trimmed = line.trim();
      if (!trimmed) return 'continue';

      const chunks = splitJsonObjects(line);
      for (const chunk of chunks) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(chunk);
        } catch {
          continue;
        }

        const record = parseQwenChatRecord(parsed, filePath, lineIndex);
        if (!record) continue;

        if (!sessionId && record.sessionId) sessionId = record.sessionId;
        if (!cwd && record.cwd) cwd = record.cwd;
        if (!gitBranch && record.gitBranch) gitBranch = record.gitBranch;
        if (!model && record.model) model = record.model;

        if (!firstTimestamp && record.timestamp) firstTimestamp = record.timestamp;
        if (record.timestamp) lastTimestamp = record.timestamp;

        if (record.type === 'user' && !firstUserMessage) {
          firstUserMessage = extractContentText(record.message);
        }

        const title = extractCustomTitle(record);
        if (title) customTitle = title;
      }
      return 'continue';
    },
    { maxLineChars: MAX_QWEN_JSONL_RECORD_CHARS },
  );

  if (!sessionId) return null;

  return {
    sessionId,
    cwd,
    gitBranch,
    summary: customTitle ?? firstUserMessage,
    firstTimestamp,
    lastTimestamp,
    model,
    lineCount,
    bytes: fileStat.size,
    mtime: fileStat.mtime,
  };
}

// ── Tool data extraction ────────────────────────────────────────────────────

function collectConfirmedDiffRefs(records: QwenChatRecord[]): ConfirmedDiffRefs {
  const refs: ConfirmedDiffRefs = { byCallId: new Set(), byParentName: new Set() };

  for (const record of records) {
    if (record.type !== 'tool_result' || !record.parentUuid || !record.toolCallResult) continue;
    const status = record.toolCallResult.status;
    if (isToolResultError(status)) continue;
    if (!isFileDiff(record.toolCallResult.resultDisplay)) continue;

    const callId = getCallId(record.toolCallResult);
    if (callId) refs.byCallId.add(callId);

    const displayName = record.toolCallResult.displayName;
    if (displayName) {
      refs.byParentName.add(responseKey(record.parentUuid, displayName));
      const category = classifyToolName(displayName);
      if (category) refs.byParentName.add(responseKey(record.parentUuid, category));
    }
  }

  return refs;
}

function extractDiffStat(rd: QwenFileDiff): { added: number; removed: number } | undefined {
  if (rd.diffStat) {
    return {
      added: rd.diffStat.model_added_lines ?? 0,
      removed: rd.diffStat.model_removed_lines ?? 0,
    };
  }

  if (!rd.fileDiff) return undefined;

  const lines = rd.fileDiff.split('\n');
  return {
    added: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    removed: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

function getFileDiffPath(rd: QwenFileDiff, parentCall: ParentFunctionCall | undefined): string {
  return getStringField(rd, 'filePath') ?? parentCall?.filePath ?? rd.fileName ?? '';
}

function getFileDiffOperation(
  displayName: string,
  rd: QwenFileDiff,
  parentCall: ParentFunctionCall | undefined,
): { operation: 'write' | 'edit'; isNewFile: boolean } {
  const isNewFile =
    rd.originalContent === null ||
    ['create', 'new', 'new_file'].includes((getStringField(rd, 'type') ?? '').toLowerCase());
  const category = classifyToolName(displayName) ?? parentCall?.category;
  return { operation: isNewFile || category === 'write' ? 'write' : 'edit', isNewFile };
}

function addFileDiffSummary(
  collector: SummaryCollector,
  displayName: string,
  rd: QwenFileDiff,
  parentCall: ParentFunctionCall | undefined,
  isError: boolean,
): void {
  const filePath = getFileDiffPath(rd, parentCall);
  const diffStat = extractDiffStat(rd);
  const { operation, isNewFile } = getFileDiffOperation(displayName, rd, parentCall);
  const diff = rd.fileDiff || undefined;

  if (operation === 'write') {
    collector.add(displayName, fileSummary('write', filePath, diffStat, isNewFile), {
      data: {
        category: 'write',
        filePath,
        isNewFile,
        ...(diff ? { diff } : {}),
        ...(diffStat ? { diffStats: diffStat } : {}),
      },
      filePath,
      isWrite: true,
      isError,
    });
    return;
  }

  collector.add(displayName, fileSummary('edit', filePath, diffStat), {
    data: {
      category: 'edit',
      filePath,
      ...(diff ? { diff } : {}),
      ...(diffStat ? { diffStats: diffStat } : {}),
    },
    filePath,
    isWrite: true,
    isError,
  });
}

function countFunctionCallsByName(parts: QwenPart[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const part of parts) {
    const name = part.functionCall?.name;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function findInlineFunctionResponse(
  parts: QwenPart[],
  name: string,
  callId: string | undefined,
  hasDuplicateName: boolean,
): ToolResponseInfo | undefined {
  if (callId) {
    for (const part of parts) {
      if (!part.functionResponse || getFunctionResponseCallId(part) !== callId) continue;
      return {
        name: part.functionResponse.name,
        output: extractFunctionResponseOutput(part),
        status: extractFunctionResponseStatus(part),
        callId,
      };
    }
  }

  if (hasDuplicateName) return undefined;

  const responsePart = parts.find((part) => part.functionResponse?.name === name);
  if (!responsePart?.functionResponse) return undefined;

  return {
    name,
    output: extractFunctionResponseOutput(responsePart),
    status: extractFunctionResponseStatus(responsePart),
    callId: getFunctionResponseCallId(responsePart),
  };
}

function findExternalToolResponse(
  responses: ToolResponses,
  parentUuid: string,
  name: string,
  callId: string | undefined,
  hasDuplicateName: boolean,
): ToolResponseInfo | undefined {
  if (callId) {
    const byCallId = responses.byCallId.get(callId);
    if (byCallId) return byCallId;
  }

  if (hasDuplicateName) return undefined;

  const byParentName = responses.byParentName.get(responseKey(parentUuid, name)) ?? [];
  return byParentName.length === 1 ? byParentName[0] : undefined;
}

function findToolResultResponse(responses: ToolResponses, record: QwenChatRecord): ToolResponseInfo | undefined {
  const callId = getCallId(record.toolCallResult);
  return callId ? responses.byCallId.get(callId) : undefined;
}

function hasConfirmedDiffForCall(
  refs: ConfirmedDiffRefs,
  parentUuid: string,
  name: string,
  category: ReturnType<typeof classifyToolName>,
  callId: string | undefined,
  hasDuplicateName: boolean,
): boolean {
  if (callId && refs.byCallId.has(callId)) return true;
  if (hasDuplicateName) return false;
  return (
    refs.byParentName.has(responseKey(parentUuid, name)) ||
    (!!category && refs.byParentName.has(responseKey(parentUuid, category)))
  );
}

function extractToolData(
  records: QwenChatRecord[],
  config?: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);
  const responses = collectToolResponses(records);
  const callsByParent = collectParentFunctionCalls(records);
  const confirmedDiffRefs = collectConfirmedDiffRefs(records);

  for (const record of records) {
    // Extract from functionCall parts in assistant messages
    if (record.type === 'assistant' && record.message?.parts) {
      const callNameCounts = countFunctionCallsByName(record.message.parts);

      for (const part of record.message.parts) {
        if (!part.functionCall) continue;
        const { name, args } = part.functionCall;
        const category = classifyToolName(name);
        if (!category) continue;
        const callId = getCallId(part.functionCall);
        const hasDuplicateName = (callNameCounts.get(name) ?? 0) > 1;

        if (
          (category === 'write' || category === 'edit') &&
          hasConfirmedDiffForCall(confirmedDiffRefs, record.uuid, name, category, callId, hasDuplicateName)
        ) {
          continue;
        }

        const fp = getToolFilePath(args) ?? '';

        const inlineResponse = findInlineFunctionResponse(record.message.parts, name, callId, hasDuplicateName);
        const externalResponse = findExternalToolResponse(responses, record.uuid, name, callId, hasDuplicateName);
        const resultStr = inlineResponse?.output ?? externalResponse?.output;
        const responseStatus = inlineResponse?.status ?? externalResponse?.status;
        const isResponseError = isToolResultError(responseStatus);

        switch (category) {
          case 'shell': {
            const cmd = getStringField(args, 'command') ?? getStringField(args, 'cmd') ?? '';
            collector.add(name, shellSummary(cmd, resultStr), {
              data: { category: 'shell', command: cmd, ...(resultStr ? { stdoutTail: resultStr.slice(-500) } : {}) },
              isError: isResponseError,
            });
            break;
          }
          case 'write': {
            collector.add(name, fileSummary('write', fp), {
              data: { category: 'write', filePath: fp },
              filePath: fp,
              isWrite: true,
              isError: isResponseError,
            });
            break;
          }
          case 'read':
            collector.add(name, fileSummary('read', fp), {
              data: { category: 'read', filePath: fp },
              filePath: fp,
              isError: isResponseError,
            });
            break;
          case 'edit':
            collector.add(name, fileSummary('edit', fp), {
              data: { category: 'edit', filePath: fp },
              filePath: fp,
              isWrite: true,
              isError: isResponseError,
            });
            break;
          case 'grep': {
            const pattern = getStringField(args, 'pattern') ?? getStringField(args, 'query') ?? '';
            collector.add(name, `grep "${truncate(pattern, 40)}"`, {
              data: { category: 'grep', pattern, ...(fp ? { targetPath: fp } : {}) },
              isError: isResponseError,
            });
            break;
          }
          case 'glob': {
            const pattern = getStringField(args, 'pattern') ?? fp;
            collector.add(name, `glob ${truncate(pattern, 50)}`, {
              data: { category: 'glob', pattern },
              isError: isResponseError,
            });
            break;
          }
          case 'search': {
            const query = getStringField(args, 'query') ?? '';
            collector.add(name, `search "${truncate(query, 50)}"`, {
              data: { category: 'search', query },
              isError: isResponseError,
            });
            break;
          }
          case 'fetch': {
            const url = getStringField(args, 'url') ?? '';
            collector.add(name, `fetch ${truncate(url, 60)}`, {
              data: {
                category: 'fetch',
                url,
                ...(resultStr ? { resultPreview: resultStr.slice(0, 100) } : {}),
              },
              isError: isResponseError,
            });
            break;
          }
          case 'task': {
            const desc = getStringField(args, 'description') ?? getStringField(args, 'prompt') ?? '';
            const agentType = getStringField(args, 'subagent_type');
            collector.add(name, `task "${truncate(desc, 60)}"${agentType ? ` (${agentType})` : ''}`, {
              data: { category: 'task', description: desc, ...(agentType ? { agentType } : {}) },
              isError: isResponseError,
            });
            break;
          }
          case 'ask': {
            const question = truncate(getStringField(args, 'question') ?? getStringField(args, 'prompt') ?? '', 80);
            collector.add(name, `ask: "${question}"`, {
              data: { category: 'ask', question },
              isError: isResponseError,
            });
            break;
          }
          default: {
            const argsStr = args ? JSON.stringify(args).slice(0, 100) : '';
            collector.add(name, mcpSummary(name, argsStr, resultStr), {
              data: {
                category: 'mcp',
                toolName: name,
                ...(argsStr ? { params: argsStr } : {}),
                ...(resultStr ? { result: resultStr.slice(0, 100) } : {}),
              },
              isError: isResponseError,
            });
          }
        }
      }
    }

    // Extract confirmed file modifications from tool_result records.
    if (record.type === 'tool_result' && record.toolCallResult) {
      const tcr = record.toolCallResult;
      const isError = isToolResultError(tcr.status);

      if (isFileDiff(tcr.resultDisplay)) {
        const response = findToolResultResponse(responses, record);
        const resultDisplayName = tcr.displayName || undefined;
        const parentCall = findParentFunctionCall(callsByParent, record, resultDisplayName ?? response?.name);
        const displayName = resultDisplayName ?? parentCall?.name ?? response?.name;
        if (!displayName) continue;

        addFileDiffSummary(collector, displayName, tcr.resultDisplay, parentCall, isError);
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

// ── Session notes extraction ────────────────────────────────────────────────

function extractSessionNotes(records: QwenChatRecord[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  for (const record of records) {
    if (record.type !== 'assistant') continue;

    if (record.model && !notes.model) notes.model = record.model;

    // Extract reasoning from thought parts
    if (record.message?.parts && reasoning.length < 5) {
      for (const thought of extractThoughtsFromParts(record.message.parts)) {
        if (reasoning.length >= 5) break;
        if (thought.length > 10) reasoning.push(truncate(thought, 200));
      }
    }

    if (record.usageMetadata) {
      if (!notes.tokenUsage) notes.tokenUsage = { input: 0, output: 0 };
      notes.tokenUsage.input += record.usageMetadata.promptTokenCount || 0;
      notes.tokenUsage.output += record.usageMetadata.candidatesTokenCount || 0;

      if (record.usageMetadata.cachedContentTokenCount) {
        if (!notes.cacheTokens) notes.cacheTokens = { creation: 0, read: 0 };
        notes.cacheTokens.read += record.usageMetadata.cachedContentTokenCount;
      }
      if (record.usageMetadata.thoughtsTokenCount) {
        notes.thinkingTokens = (notes.thinkingTokens || 0) + record.usageMetadata.thoughtsTokenCount;
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

// ── Public API ──────────────────────────────────────────────────────────────

function aggregateRecordGroup(records: QwenChatRecord[]): QwenChatRecord {
  const base: QwenChatRecord = { ...records[0] };

  for (const record of records.slice(1)) {
    if (record.message) {
      base.message = {
        role: base.message?.role ?? record.message.role,
        parts: [...(base.message?.parts ?? []), ...(record.message.parts ?? [])],
      };
    }

    if (record.usageMetadata) base.usageMetadata = record.usageMetadata;
    if (record.toolCallResult && !base.toolCallResult) base.toolCallResult = record.toolCallResult;
    if (record.model && !base.model) base.model = record.model;
    if (record.timestamp > base.timestamp) base.timestamp = record.timestamp;
  }

  return base;
}

function aggregateRecordsByUuid(records: QwenChatRecord[]): QwenChatRecord[] {
  const groups = new Map<string, QwenChatRecord[]>();
  const order: string[] = [];

  for (const record of records) {
    if (!groups.has(record.uuid)) {
      groups.set(record.uuid, []);
      order.push(record.uuid);
    }
    groups.get(record.uuid)!.push(record);
  }

  return order.map((uuid) => aggregateRecordGroup(groups.get(uuid)!));
}

function getLastMainRecordUuid(records: QwenChatRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (!getBooleanField(records[i], 'isSidechain')) return records[i].uuid;
  }
  return records.at(-1)?.uuid;
}

/**
 * Reconstruct the main conversation path by walking parentUuid backwards from
 * the last appended non-sidechain record. Mirrors upstream Qwen Code's
 * `sessionService.reconstructHistory` (packages/core/src/services/sessionService.ts)
 * which starts at `records[records.length - 1].uuid` (or a supplied leafUuid)
 * and walks parents until the chain breaks.
 *
 * **Broken-chain policy:** when a parentUuid does not resolve in the current
 * record set (incomplete log, deleted ancestor, or fork merge artefacts), we
 * fall back to the full append-ordered `aggregated` set instead of truncating
 * at the last valid ancestor. Upstream truncates because it owns the live
 * session. We're a *handoff* — surfacing every appended turn keeps the
 * receiving tool from silently losing work the user could see in Qwen Code's
 * UI. The trade-off is that abandoned branches reappear on broken chains;
 * that is the lesser evil for a one-shot context dump (open question #2 in
 * the PR description, resolved deliberately).
 *
 * Cycle protection: `visited` guard breaks if a parent loop is detected.
 */
function reconstructMainPath(records: QwenChatRecord[]): QwenChatRecord[] {
  if (records.length === 0) return [];

  const aggregated = aggregateRecordsByUuid(records);
  const byUuid = new Map(aggregated.map((record) => [record.uuid, record]));
  const startUuid = getLastMainRecordUuid(records);
  if (!startUuid) return aggregated;

  const pathResult: QwenChatRecord[] = [];
  const visited = new Set<string>();
  let current = byUuid.get(startUuid);
  let brokenChain = false;

  while (current) {
    if (visited.has(current.uuid)) {
      brokenChain = true;
      break;
    }
    visited.add(current.uuid);
    pathResult.unshift(current);
    if (!current.parentUuid) break;
    const parent = byUuid.get(current.parentUuid);
    if (!parent) {
      brokenChain = true;
      break;
    }
    current = parent;
  }

  return brokenChain || pathResult.length === 0 ? aggregated : pathResult;
}

export async function parseQwenCodeSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const meta = await extractSessionMeta(filePath);
      if (!meta) continue;

      const summary = cleanSummary(meta.summary ?? '') || undefined;

      sessions.push({
        id: meta.sessionId,
        source: 'qwen-code',
        cwd: meta.cwd,
        repo: extractRepoFromCwd(meta.cwd),
        branch: meta.gitBranch,
        lines: meta.lineCount,
        bytes: meta.bytes,
        createdAt: parseTimestamp(meta.firstTimestamp, meta.mtime),
        updatedAt: parseTimestamp(meta.lastTimestamp, meta.mtime),
        originalPath: filePath,
        summary,
        model: meta.model,
      });
    } catch (err) {
      logger.debug('qwen-code: skipping unparseable session', filePath, err);
    }
  }

  return sessions
    .filter((s) => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function extractQwenCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const records = await readJsonlRecords(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  const pendingTasks: string[] = [];

  const toolData = extractToolData(records, resolvedConfig);
  const sessionNotes = extractSessionNotes(records);

  // Extract recent messages and pending tasks from main conversation path
  const mainPath = reconstructMainPath(records);
  const messageRecords = mainPath.filter((r) => r.type === 'user' || r.type === 'assistant');
  for (const record of messageRecords.slice(-resolvedConfig.recentMessages * 2)) {
    // Extract pending tasks from thought parts
    if (record.type === 'assistant' && record.message?.parts && pendingTasks.length < 5) {
      for (const thought of extractThoughtsFromParts(record.message.parts)) {
        if (pendingTasks.length >= 5) break;
        const lower = thought.toLowerCase();
        if (
          lower.includes('todo') ||
          lower.includes('next') ||
          lower.includes('remaining') ||
          lower.includes('need to') ||
          lower.includes('next step')
        ) {
          pendingTasks.push(truncate(thought, 200));
        }
      }
    }

    const text = extractContentText(record.message);
    if (!text) continue;

    recentMessages.push({
      role: record.type === 'user' ? 'user' : 'assistant',
      content: text,
      timestamp: new Date(record.timestamp),
    });
  }

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    toolData.filesModified,
    pendingTasks,
    toolData.summaries,
    sessionNotes,
    resolvedConfig,
  );

  return {
    session: sessionNotes?.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: trimmed,
    filesModified: toolData.filesModified,
    pendingTasks,
    toolSummaries: toolData.summaries,
    sessionNotes,
    markdown,
  };
}

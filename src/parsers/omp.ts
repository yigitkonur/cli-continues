import * as fs from 'node:fs';
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
import { classifyToolName } from '../types/tool-names.js';
import { countDiffStats, extractStdoutTail } from '../utils/diff.js';
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepo, homeDir } from '../utils/parser-helpers.js';
import { matchesCwd } from '../utils/slug.js';
import {
  extractExitCode,
  fileSummary,
  globSummary,
  grepSummary,
  mcpSummary,
  SummaryCollector,
  searchSummary,
  shellSummary,
  truncate,
} from '../utils/tool-summarizer.js';

const OMP_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(homeDir(), '.omp', 'agent');
const OMP_SESSIONS_DIR = path.join(OMP_AGENT_DIR, 'sessions');
const MAX_EXACT_LINE_COUNT_BYTES = 1024 * 1024;
const MAX_METADATA_SCAN_BYTES = 1024 * 1024;

type OmpContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type OmpMessagePayload = {
  role?: string;
  content?: string | OmpContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoningTokens?: number;
  };
};

type OmpRecord = {
  type?: string;
  customType?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  title?: string;
  updatedAt?: string;
  version?: number;
  cwd?: string;
  model?: string;
  thinkingLevel?: string;
  configured?: string;
  message?: OmpMessagePayload;
  data?: {
    toolCallId?: string;
    toolName?: string;
    startedAt?: string;
    args?: Record<string, unknown>;
    intent?: string;
    reason?: string;
    kind?: string;
    recordedAt?: string;
    pendingToolCalls?: unknown[];
  };
};

type OmpSessionInfo = {
  id: string;
  cwd: string;
  title: string;
  model?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

async function findSessionFiles(): Promise<string[]> {
  return findFiles(OMP_SESSIONS_DIR, {
    match: (entry) => entry.name.endsWith('.jsonl'),
  });
}

function parseValidDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseFilename(filePath: string): { timestamp?: Date; id?: string } {
  const match = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)\.jsonl$/);
  if (!match) return {};
  const [, rawTimestamp, id] = match;
  return {
    timestamp: parseValidDate(rawTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')),
    id,
  };
}

function extractTextContent(content: OmpMessagePayload['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function firstUserMessage(records: OmpRecord[]): string {
  for (const record of records) {
    if (record.type !== 'message' || record.message?.role !== 'user') continue;
    const content = extractTextContent(record.message.content).trim();
    if (content) return content;
  }
  return '';
}

async function parseSessionInfo(filePath: string): Promise<OmpSessionInfo | null> {
  const filename = parseFilename(filePath);
  const info: Partial<OmpSessionInfo> = {
    ...(filename.id ? { id: filename.id } : {}),
    ...(filename.timestamp ? { createdAt: filename.timestamp } : {}),
  };
  const headRecords: OmpRecord[] = [];

  await scanJsonlHead(
    filePath,
    200,
    (parsed) => {
      const record = parsed as OmpRecord;
      headRecords.push(record);

      if (record.type === 'title' && typeof record.title === 'string' && !info.title) {
        info.title = record.title;
      }

      if (record.type === 'session') {
        if (typeof record.id === 'string') info.id = record.id;
        if (typeof record.cwd === 'string') info.cwd = record.cwd;
        if (typeof record.title === 'string') info.title = record.title;
        info.createdAt = parseValidDate(record.timestamp) ?? info.createdAt;
      }

      if (record.type === 'model_change' && typeof record.model === 'string' && !info.model) {
        info.model = record.model;
      }

      const timestamp = parseValidDate(record.updatedAt ?? record.timestamp);
      if (timestamp && (!info.updatedAt || timestamp.getTime() > info.updatedAt.getTime())) info.updatedAt = timestamp;

      return info.id && info.cwd && info.title && info.model ? 'stop' : 'continue';
    },
    { maxBytes: MAX_METADATA_SCAN_BYTES },
  );

  if (!info.title) info.title = cleanSummary(firstUserMessage(headRecords));
  if (!info.id) return null;

  return {
    id: info.id,
    cwd: info.cwd ?? '',
    title: info.title ?? '',
    ...(info.model ? { model: info.model } : {}),
    ...(info.createdAt ? { createdAt: info.createdAt } : {}),
    ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
  };
}

async function extractLastTimestamp(filePath: string): Promise<Date | undefined> {
  let lastTimestamp: Date | undefined;
  await scanJsonlFile(
    filePath,
    (parsed) => {
      const record = parsed as OmpRecord;
      const timestamp = parseValidDate(record.updatedAt ?? record.timestamp ?? record.data?.recordedAt);
      if (timestamp && (!lastTimestamp || timestamp.getTime() > lastTimestamp.getTime())) lastTimestamp = timestamp;
      return 'continue';
    },
    { maxBytes: MAX_METADATA_SCAN_BYTES },
  );
  return lastTimestamp;
}

export async function parseOmpSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const parsedSessions = await mapConcurrent(files, 16, async (filePath): Promise<UnifiedSession | null> => {
    try {
      const info = await parseSessionInfo(filePath);
      if (!info) return null;
      if (options.cwd && info.cwd && !matchesCwd(info.cwd, options.cwd)) return null;

      const fileStats = fs.statSync(filePath);
      const stats =
        options.lightweight || fileStats.size > MAX_EXACT_LINE_COUNT_BYTES
          ? { lines: 0, bytes: fileStats.size }
          : await getFileStats(filePath);
      const lastTimestamp =
        !options.lightweight && fileStats.size <= MAX_METADATA_SCAN_BYTES
          ? await extractLastTimestamp(filePath)
          : undefined;
      const updatedAt = lastTimestamp ?? (fileStats.size > MAX_METADATA_SCAN_BYTES ? fileStats.mtime : info.updatedAt);

      return {
        id: info.id,
        source: 'omp',
        cwd: info.cwd,
        repo: extractRepo({ cwd: info.cwd }),
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: info.createdAt ?? fileStats.birthtime,
        updatedAt: updatedAt ?? fileStats.mtime,
        originalPath: filePath,
        summary: cleanSummary(info.title) || undefined,
        ...(info.model ? { model: info.model } : {}),
      };
    } catch (err) {
      logger.debug('omp: skipping unparseable session', filePath, err);
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

function toolResultText(record: OmpRecord): string {
  if (record.type !== 'message' || record.message?.role !== 'toolResult') return '';
  return extractTextContent(record.message.content);
}

function pathArg(args: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['path', 'filePath', 'file_path', 'targetPath', 'cwd']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function commandArg(args: Record<string, unknown> | undefined): string | undefined {
  const value = args?.command;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function addToolSummary(record: OmpRecord, resultByCallId: Map<string, OmpRecord>, collector: SummaryCollector): void {
  if (record.customType !== 'tool_execution_start') return;
  const toolName = record.data?.toolName;
  if (!toolName) return;

  const args = record.data?.args ?? {};
  const result = record.data?.toolCallId ? resultByCallId.get(record.data.toolCallId) : undefined;
  const resultText = result ? toolResultText(result) : '';
  const isError = result?.message?.isError === true;
  const category = classifyToolName(toolName) ?? 'mcp';
  const filePath = pathArg(args);

  switch (category) {
    case 'shell': {
      const command = commandArg(args) ?? record.data?.intent ?? toolName;
      collector.add('Bash', shellSummary(command, resultText), {
        data: {
          category: 'shell',
          command,
          ...(extractExitCode(resultText) !== undefined ? { exitCode: extractExitCode(resultText) } : {}),
          ...(extractStdoutTail(resultText, 20) ? { stdoutTail: extractStdoutTail(resultText, 20) } : {}),
          ...(isError ? { errored: true, errorMessage: truncate(resultText, 200) } : {}),
        },
        isError,
      });
      return;
    }
    case 'read': {
      const target = filePath ?? String(args.url ?? args.i ?? '(unknown)');
      collector.add('Read', fileSummary('read', target), {
        data: { category: 'read', filePath: target },
        isError,
      });
      return;
    }
    case 'write': {
      const target = filePath ?? '(unknown)';
      collector.add('Write', fileSummary('write', target), {
        data: { category: 'write', filePath: target },
        filePath: target,
        isWrite: true,
        isError,
      });
      return;
    }
    case 'edit': {
      const target = filePath ?? '(unknown)';
      const diffStats = countDiffStats(resultText);
      collector.add('Edit', fileSummary('edit', target, diffStats), {
        data: { category: 'edit', filePath: target, diff: resultText, diffStats },
        filePath: target,
        isWrite: true,
        isError,
      });
      return;
    }
    case 'grep': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : String(args.i ?? '(pattern)');
      collector.add('Grep', grepSummary(pattern, filePath), {
        data: { category: 'grep', pattern, ...(filePath ? { targetPath: filePath } : {}) },
        isError,
      });
      return;
    }
    case 'glob': {
      const pattern = typeof args.path === 'string' ? args.path : String(args.i ?? '(pattern)');
      collector.add('Glob', globSummary(pattern), {
        data: { category: 'glob', pattern },
        isError,
      });
      return;
    }
    case 'search': {
      const query = typeof args.query === 'string' ? args.query : String(args.i ?? '');
      collector.add('WebSearch', searchSummary(query), {
        data: { category: 'search', query },
        isError,
      });
      return;
    }
    default: {
      const argsText = JSON.stringify(args).slice(0, 200);
      collector.add(toolName, mcpSummary(toolName, argsText, resultText), {
        data: {
          category: 'mcp',
          toolName,
          params: argsText,
          ...(resultText ? { result: truncate(resultText, 100) } : {}),
        },
        isError,
      });
    }
  }
}

function extractToolData(
  records: OmpRecord[],
  config: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);
  const resultByCallId = new Map<string, OmpRecord>();

  for (const record of records) {
    if (record.type === 'message' && record.message?.role === 'toolResult' && record.message.toolCallId) {
      resultByCallId.set(record.message.toolCallId, record);
    }
  }

  for (const record of records) {
    addToolSummary(record, resultByCallId, collector);
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

function extractSessionNotes(records: OmpRecord[], session: UnifiedSession): SessionNotes {
  const notes: SessionNotes = {
    ...(session.model ? { model: session.model } : {}),
    rawAccess: { kind: 'file', path: session.originalPath, redacted: true },
  };
  const reasoning: string[] = [];
  const sourceMetadata: Record<string, unknown> = {};

  for (const record of records) {
    if (record.type === 'session') {
      if (typeof record.id === 'string') sourceMetadata.sessionId = record.id;
      if (typeof record.version === 'number') sourceMetadata.cliVersion = `v${record.version}`;
      if (typeof record.timestamp === 'string') sourceMetadata.sessionTimestamp = record.timestamp;
      continue;
    }

    if (record.type === 'model_change' && typeof record.model === 'string') {
      notes.model = record.model;
      sourceMetadata.model = record.model;
      continue;
    }

    if (record.type === 'thinking_level_change') {
      if (typeof record.thinkingLevel === 'string') sourceMetadata.thinkingLevel = record.thinkingLevel;
      if (typeof record.configured === 'string') sourceMetadata.thinkingConfigured = record.configured;
      continue;
    }

    if (record.customType === 'session_exit') {
      notes.lifecycle ??= [];
      notes.lifecycle.push({
        type: 'session_exit',
        timestamp: record.timestamp,
        metadata: {
          ...(record.data?.reason ? { reason: record.data.reason } : {}),
          ...(record.data?.kind ? { kind: record.data.kind } : {}),
          ...(record.data?.recordedAt ? { recordedAt: record.data.recordedAt } : {}),
        },
      });
      continue;
    }

    if (record.type !== 'message' || !record.message) continue;

    if (record.message.provider) sourceMetadata.provider = record.message.provider;
    if (record.message.model && !notes.model) notes.model = record.message.model;

    const usage = record.message.usage;
    if (usage) {
      const input = usage.input ?? notes.tokenUsage?.input ?? 0;
      const output = usage.output ?? notes.tokenUsage?.output ?? 0;
      notes.tokenUsage = { input, output };
      const cacheRead = usage.cacheRead ?? notes.cacheTokens?.read ?? 0;
      const cacheWrite = usage.cacheWrite ?? notes.cacheTokens?.creation ?? 0;
      if (cacheRead > 0 || cacheWrite > 0) notes.cacheTokens = { creation: cacheWrite, read: cacheRead };
      if (typeof usage.reasoningTokens === 'number' && usage.reasoningTokens > 0) {
        notes.thinkingTokens = usage.reasoningTokens;
      }
    }

    if (record.message.role === 'assistant' && Array.isArray(record.message.content)) {
      for (const block of record.message.content) {
        if (block.type !== 'thinking' || typeof block.thinking !== 'string' || reasoning.length >= 5) continue;
        const firstLine = block.thinking
          .replace(/^\*\*|\*\*$/g, '')
          .split(/[.\n]/)[0]
          ?.trim();
        if (firstLine) reasoning.push(truncate(firstLine, 200));
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  if (Object.keys(sourceMetadata).length > 0) notes.sourceMetadata = sourceMetadata;
  return notes;
}

function extractConversation(records: OmpRecord[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const record of records) {
    if (record.type !== 'message' || !record.message) continue;
    const role = record.message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
    const content = extractTextContent(record.message.content).trim();
    if (!content) continue;
    messages.push({
      role,
      content,
      timestamp: parseValidDate(record.timestamp),
      sourceId: record.id,
      sourceParentId: record.parentId ?? undefined,
    });
  }
  return messages;
}

function buildTimeline(messages: ConversationMessage[], records: OmpRecord[]): SessionEvent[] {
  const events: SessionEvent[] = [];

  for (const message of messages) {
    events.push({
      kind: 'message',
      sequence: 0,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      sourceId: message.sourceId,
      sourceParentId: message.sourceParentId,
    });
  }

  for (const record of records) {
    if (record.customType === 'tool_execution_start' && record.data?.toolName) {
      events.push({
        kind: 'tool_call',
        sequence: 0,
        timestamp: parseValidDate(record.timestamp ?? record.data.startedAt),
        id: record.id,
        sourceId: record.id,
        sourceParentId: record.parentId ?? undefined,
        toolName: record.data.toolName,
        toolCallId: record.data.toolCallId,
        arguments: record.data.args,
        content: record.data.intent,
      });
    } else if (record.type === 'message' && record.message?.role === 'toolResult') {
      events.push({
        kind: 'tool_result',
        sequence: 0,
        timestamp: parseValidDate(record.timestamp),
        id: record.id,
        sourceId: record.id,
        sourceParentId: record.parentId ?? undefined,
        toolName: record.message.toolName,
        toolCallId: record.message.toolCallId,
        status: record.message.isError ? 'error' : 'ok',
        result: truncate(toolResultText(record), 1000),
      });
    } else if (record.customType === 'session_exit') {
      events.push({
        kind: 'lifecycle',
        sequence: 0,
        timestamp: parseValidDate(record.timestamp),
        id: record.id,
        sourceId: record.id,
        sourceParentId: record.parentId ?? undefined,
        status: 'session_exit',
        metadata: record.data,
      });
    }
  }

  events.sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
  return events.map((event, sequence) => ({ ...event, sequence }));
}

export async function extractOmpContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const records = await readJsonlFile<OmpRecord>(session.originalPath);
  const { summaries: toolSummaries, filesModified } = extractToolData(records, resolvedConfig);
  const sessionNotes = extractSessionNotes(records, session);
  const pendingTasks: string[] = [];
  const allMessages = extractConversation(records);
  const trimmed = allMessages.slice(-resolvedConfig.recentMessages);
  const timeline = buildTimeline(trimmed, records);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
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
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

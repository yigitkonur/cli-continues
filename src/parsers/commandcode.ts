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
  UnifiedSession,
} from '../types/index.js';
import { isSystemContent } from '../utils/content.js';
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { cwdFromSlug } from '../utils/slug.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';
import { truncate } from '../utils/tool-summarizer.js';

interface CommandCodeBlock {
  type?: string;
  text?: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface CommandCodeMessage {
  role?: string;
  content?: string | CommandCodeBlock[];
  model?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  toolCallId?: string;
  isError?: boolean;
}

interface CommandCodeRecord {
  type?: string;
  version?: number;
  id?: string;
  sessionId?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  role?: string;
  content?: string | CommandCodeBlock[];
  message?: CommandCodeMessage;
  model?: string;
  modelId?: string;
  summary?: string;
  name?: string;
  gitBranch?: string;
}

const COMMANDCODE_HOME = path.join(homeDir(), '.commandcode');
/** Files up to this size get exact line counts even in lightweight discovery. */
const SMALL_FILE_EXACT_COUNT_BYTES = 8 * 1024;

function projectsDir(): string {
  return path.join(process.env.COMMANDCODE_HOME || COMMANDCODE_HOME, 'projects');
}

function sessionFiles(): string[] {
  return findFiles(projectsDir(), {
    match: (entry) => entry.name.endsWith('.jsonl') && !entry.name.endsWith('.checkpoints.jsonl'),
    maxDepth: 1,
  });
}

function recordMessage(record: CommandCodeRecord): CommandCodeMessage | undefined {
  if (record.type === 'message') return record.message;
  if (record.role) return { role: record.role, content: record.content };
  return undefined;
}

function textFromContent(content: CommandCodeMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function inferredCwd(filePath: string, headerCwd?: string): string {
  return headerCwd || cwdFromSlug(path.basename(path.dirname(filePath)));
}

function readSidecarModel(filePath: string): string | undefined {
  const sidecar = filePath.replace(/\.jsonl$/u, '.meta.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

async function scanMetadata(
  filePath: string,
  lightweight: boolean,
): Promise<{
  id?: string;
  cwd?: string;
  firstUserMessage: string;
  sessionName?: string;
  model?: string;
  branch?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
}> {
  let id: string | undefined;
  let cwd: string | undefined;
  let firstUserMessage = '';
  let sessionName: string | undefined;
  let model = readSidecarModel(filePath);
  let branch: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  const visitor = (value: unknown): 'continue' => {
    const record = value as CommandCodeRecord;
    if (record.type === 'session') {
      id ||= record.id;
      cwd ||= record.cwd;
    }
    id ||= record.sessionId;
    if (record.timestamp) {
      firstTimestamp ||= record.timestamp;
      lastTimestamp = record.timestamp;
    }
    if (record.type === 'session_info' && record.name) sessionName = record.name;
    if (record.type === 'model_change') model = record.modelId || record.model || model;
    branch = record.gitBranch && record.gitBranch !== '-' ? record.gitBranch : branch;
    const message = recordMessage(record);
    if (message?.model) model = message.model;
    if (!firstUserMessage && message?.role === 'user') firstUserMessage = textFromContent(message.content);
    return 'continue';
  };

  if (lightweight) {
    await scanJsonlHead(filePath, 100, (value) => {
      visitor(value);
      return firstUserMessage && id ? 'stop' : 'continue';
    });
  } else await scanJsonlFile(filePath, visitor);
  return { id, cwd, firstUserMessage, sessionName, model, branch, firstTimestamp, lastTimestamp };
}

export async function parseCommandCodeSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const lightweight = options.lightweight === true;
  const parsed = await mapConcurrent(sessionFiles(), 16, async (filePath): Promise<UnifiedSession | null> => {
    try {
      const metadata = await scanMetadata(filePath, lightweight);
      const id = metadata.id || path.basename(filePath, '.jsonl');
      const cwd = inferredCwd(filePath, metadata.cwd);
      if (options.cwd && path.resolve(cwd) !== path.resolve(options.cwd)) return null;
      const stat = fs.statSync(filePath);
      // Exact line counts only for small files: large transcripts skip
      // counting in lightweight discovery, while tiny session stubs stay
      // cheap to measure and filter as empty.
      const stats =
        lightweight && stat.size > SMALL_FILE_EXACT_COUNT_BYTES
          ? { lines: 0, bytes: stat.size }
          : await getFileStats(filePath);
      return {
        id,
        source: 'cmd',
        cwd,
        repo: extractRepoFromCwd(cwd),
        branch: metadata.branch,
        summary: metadata.sessionName || cleanSummary(metadata.firstUserMessage) || undefined,
        lines: stats.lines,
        bytes: stat.size,
        createdAt: metadata.firstTimestamp ? new Date(metadata.firstTimestamp) : stat.birthtime,
        // Lightweight discovery stops at the first user message, so file mtime
        // is the accurate "last active" signal for ordering.
        updatedAt: lightweight ? stat.mtime : metadata.lastTimestamp ? new Date(metadata.lastTimestamp) : stat.mtime,
        originalPath: filePath,
        model: metadata.model,
      };
    } catch (err) {
      logger.debug('cmd: skipping unparseable session', filePath, err);
      return null;
    }
  });
  return parsed
    .filter((session): session is UnifiedSession => session !== null)
    .filter((session) => session.lines === 0 || session.lines > 1)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}

export async function extractCommandCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const allRecords = await readJsonlFile<CommandCodeRecord>(session.originalPath);
  const records = activeBranch(allRecords);
  const anthropicMessages = toAnthropicMessages(records);
  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMessages, resolvedConfig);
  const sessionNotes = extractNotes(records, session.originalPath, session.model);
  const recentMessages: ConversationMessage[] = [];
  const timeline: SessionEvent[] = [];
  let sequence = 0;

  for (const record of records) {
    const message = recordMessage(record);
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = textFromContent(message.content);
    if (!text || isSystemContent(text)) continue;
    const normalized: ConversationMessage = {
      role: message.role,
      content: text,
      timestamp: record.timestamp ? new Date(record.timestamp) : undefined,
      sourceId: record.id,
      sourceParentId: record.parentId ?? undefined,
    };
    recentMessages.push(normalized);
    timeline.push({ kind: 'message', sequence: sequence++, ...normalized });
  }

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);
  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    [],
    toolSummaries,
    sessionNotes,
    resolvedConfig,
    'inline',
    timeline,
  );
  return {
    session: sessionNotes.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks: [],
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

function activeBranch(records: CommandCodeRecord[]): CommandCodeRecord[] {
  const treeRecords = records.filter((record) => record.type !== 'session' && record.id);
  if (!treeRecords.some((record) => record.parentId !== undefined)) return records.filter((record) => record.role);
  const byId = new Map(treeRecords.map((record) => [record.id as string, record]));
  const branch: CommandCodeRecord[] = [];
  let current: CommandCodeRecord | undefined = treeRecords.at(-1);
  const visited = new Set<string>();
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'value' in output) {
    const value = (output as { value?: unknown }).value;
    if (typeof value === 'string') return value;
  }
  try {
    return output === undefined ? '' : JSON.stringify(output);
  } catch {
    return String(output ?? '');
  }
}

function toAnthropicMessages(records: CommandCodeRecord[]): AnthropicMessage[] {
  return records.flatMap((record) => {
    const message = recordMessage(record);
    if (!message) return [];
    if (record.role === 'tool') {
      const blocks = Array.isArray(record.content) ? record.content : [];
      return [
        {
          role: 'user',
          content: blocks
            .filter((block) => block.type === 'tool-result')
            .map((block) => ({
              type: 'tool_result',
              tool_use_id: block.toolCallId || '',
              content: stringifyToolOutput(block.output),
            })),
        } as AnthropicMessage,
      ];
    }
    if (message.role === 'toolResult') {
      return [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId || '',
              content: textFromContent(message.content),
              is_error: message.isError,
            },
          ],
        } as AnthropicMessage,
      ];
    }
    const content = Array.isArray(message.content)
      ? message.content.map((block) => {
          if (block.type === 'tool-call') {
            return {
              type: 'tool_use',
              id: block.toolCallId || '',
              name: block.toolName || '',
              input: block.input || {},
            };
          }
          if (block.type === 'toolCall') {
            return {
              type: 'tool_use',
              id: block.id || '',
              name: block.name || '',
              input: block.arguments || {},
            };
          }
          return block.type === 'reasoning' ? { type: 'thinking', thinking: block.text || '' } : block;
        })
      : message.content;
    return [{ role: message.role || 'user', content } as AnthropicMessage];
  });
}

function extractNotes(records: CommandCodeRecord[], originalPath: string, fallbackModel?: string): SessionNotes {
  const notes: SessionNotes = { model: fallbackModel, rawAccess: { kind: 'file', path: originalPath } };
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const record of records) {
    if (record.type === 'model_change') notes.model = record.modelId || record.model || notes.model;
    if (record.type === 'compaction' && record.summary) notes.compactSummary = truncate(record.summary, 500);
    const message = recordMessage(record);
    if (!message) continue;
    notes.model = message.model || notes.model;
    input += message.usage?.input || 0;
    output += message.usage?.output || 0;
    cacheRead += message.usage?.cacheRead || 0;
    cacheWrite += message.usage?.cacheWrite || 0;
  }
  if (input || output) notes.tokenUsage = { input, output };
  if (cacheRead || cacheWrite) notes.cacheTokens = { read: cacheRead, creation: cacheWrite };
  const reasoning = extractThinkingHighlights(toAnthropicMessages(records));
  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  ReasoningStep,
  SessionContext,
  SessionEvent,
  SessionNotes,
  SessionParseOptions,
  UnifiedSession,
} from '../types/index.js';
import type { ClaudeMessage } from '../types/schemas.js';
import { extractTextFromBlocks, isRealUserMessage } from '../utils/content.js';
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown, safePath } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import { matchesCwd } from '../utils/slug.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
  isThinkingTool,
} from '../utils/tool-extraction.js';
import { truncate } from '../utils/tool-summarizer.js';

const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
  : path.join(homeDir(), '.claude', 'projects');

export function claudeProjectSlugFromCwd(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/:/g, '').replace(/[/.]/g, '-');
}

/**
 * Find all Claude session files recursively
 */
async function findSessionFiles(options: SessionParseOptions = {}): Promise<string[]> {
  const roots = options.cwd
    ? [path.join(CLAUDE_PROJECTS_DIR, claudeProjectSlugFromCwd(options.cwd))]
    : [CLAUDE_PROJECTS_DIR];

  return roots.flatMap((root) =>
    findFiles(root, {
      match: (entry) =>
        entry.name.endsWith('.jsonl') &&
        !entry.name.includes('debug') &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(entry.name),
    }),
  );
}

/**
 * Parse session metadata and first user message
 */
async function parseSessionInfo(
  filePath: string,
  options: SessionParseOptions = {},
): Promise<{
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  firstUserMessage: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
}> {
  let sessionId = '';
  let cwd = '';
  let gitBranch = '';
  let firstUserMessage = '';
  let firstTimestamp = '';
  let lastTimestamp = '';
  let firstTimeMs = Number.POSITIVE_INFINITY;
  let lastTimeMs = Number.NEGATIVE_INFINITY;

  const visitor = (parsed: unknown): 'continue' | 'stop' => {
    if (typeof parsed !== 'object' || parsed === null) return 'continue';
    const msg = parsed as ClaudeMessage;
    if (msg.sessionId && !sessionId) sessionId = msg.sessionId;
    if (msg.cwd && !cwd) cwd = msg.cwd;
    if (msg.gitBranch && !gitBranch) gitBranch = msg.gitBranch;
    const timestamp = getClaudeMessageTimestamp(msg);
    if (timestamp) {
      const timeMs = Date.parse(timestamp);
      if (!Number.isNaN(timeMs)) {
        if (timeMs < firstTimeMs) {
          firstTimeMs = timeMs;
          firstTimestamp = timestamp;
        }
        if (timeMs > lastTimeMs) {
          lastTimeMs = timeMs;
          lastTimestamp = timestamp;
        }
      }
    }

    if (!firstUserMessage && msg.type === 'user' && msg.message?.content) {
      const content = stripClaudeLocalCommandMarkup(extractTextFromBlocks(msg.message.content));
      if (isRealUserMessage(content)) {
        firstUserMessage = content;
      }
    }
    if (options.lightweight && sessionId && cwd && firstUserMessage) return 'stop';
    return 'continue';
  };

  if (options.lightweight) {
    await scanJsonlHead(filePath, 50, visitor);
  } else {
    await scanJsonlFile(filePath, visitor);
  }

  if (!sessionId) {
    sessionId = path.basename(filePath, '.jsonl');
  }

  return { sessionId, cwd, gitBranch, firstUserMessage, firstTimestamp, lastTimestamp };
}

/**
 * Parse all Claude sessions
 */
export async function parseClaudeSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const files = await findSessionFiles(options);
  const parsedSessions = await mapConcurrent(files, 16, async (filePath): Promise<UnifiedSession | null> => {
    try {
      const info = await parseSessionInfo(filePath, options);
      if (options.cwd && info.cwd && !matchesCwd(info.cwd, options.cwd)) return null;

      const fileStats = fs.statSync(filePath);
      const stats = options.lightweight ? { lines: 0, bytes: fileStats.size } : await getFileStats(filePath);

      const summary = cleanSummary(info.firstUserMessage);
      const repo = extractRepoFromCwd(info.cwd);

      return {
        id: info.sessionId,
        source: 'claude',
        cwd: info.cwd,
        repo,
        branch: info.gitBranch,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: !options.lightweight && info.firstTimestamp ? new Date(info.firstTimestamp) : fileStats.birthtime,
        updatedAt: !options.lightweight && info.lastTimestamp ? new Date(info.lastTimestamp) : fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
      };
    } catch (err) {
      logger.debug('claude: skipping unparseable session', filePath, err);
      // Skip files we can't parse
      return null;
    }
  });

  const sessions = parsedSessions.filter((session): session is UnifiedSession => session !== null);
  const sorted = sessions.filter((s) => s.bytes > 200).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return options.limit ? sorted.slice(0, options.limit) : sorted;
}

/**
 * Check if a user message contains actual human-typed text blocks
 * (as opposed to being entirely tool_result blocks).
 */
function hasHumanTextBlocks(msg: ClaudeMessage): boolean {
  const content = msg.message?.content;
  if (!content) return false;
  if (typeof content === 'string') return isRealUserMessage(stripClaudeLocalCommandMarkup(content));
  return content.some(
    (block) => block.type === 'text' && block.text && isRealUserMessage(stripClaudeLocalCommandMarkup(block.text)),
  );
}

function isClaudeMetaMessage(msg: ClaudeMessage): boolean {
  const raw = msg as Record<string, unknown>;
  return raw.isMeta === true || msg.type === 'permission-mode' || msg.type === 'file-history-snapshot';
}

function stripClaudeLocalCommandMarkup(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/giu, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/giu, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/giu, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/giu, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/giu, '')
    .trim();
}

function getClaudeMessageTimestamp(msg: ClaudeMessage): string | undefined {
  if (msg.timestamp) return msg.timestamp;
  const raw = msg as Record<string, unknown>;
  const snapshot = raw.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const timestamp = (snapshot as Record<string, unknown>).timestamp;
  return typeof timestamp === 'string' ? timestamp : undefined;
}

function getClaudeTagContent(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'iu'));
  if (!match) return undefined;
  return match[0]
    .replace(new RegExp(`^<${tag}>`, 'iu'), '')
    .replace(new RegExp(`<\\/${tag}>$`, 'iu'), '')
    .trim();
}

function extractClaudeLocalCommandDetails(text: string): { content: string; metadata: Record<string, unknown> } {
  const metadata: Record<string, unknown> = {};
  const commandName = getClaudeTagContent(text, 'command-name');
  const commandMessage = getClaudeTagContent(text, 'command-message');
  const commandArgs = getClaudeTagContent(text, 'command-args');
  const stdout = getClaudeTagContent(text, 'local-command-stdout');

  if (commandName) metadata.commandName = commandName;
  if (commandMessage) metadata.commandMessage = commandMessage;
  if (commandArgs) metadata.commandArgs = commandArgs;

  return {
    content: stdout || commandMessage || commandName || stripClaudeLocalCommandMarkup(text),
    metadata,
  };
}

/**
 * Parsed queue-operation entry from a queue-operation JSONL event.
 */
interface QueueOperationEntry {
  taskId: string;
  description: string;
  taskType?: string;
  operation: string;
  status?: string;
}

interface TaskStatusEntry {
  taskId: string;
  status?: string;
  taskType?: string;
  description?: string;
  source: 'queue' | 'user_notification' | 'task_output';
}

interface AgentToolResultEntry {
  agentId: string;
  description: string;
  status?: string;
  outputFile?: string;
  result?: string;
}

function extractTagValue(text: string, tags: string[]): string | undefined {
  for (const tag of tags) {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

function extractTaskStatusesFromTaggedText(text: string, source: TaskStatusEntry['source']): TaskStatusEntry[] {
  const statuses: TaskStatusEntry[] = [];
  const notificationBlocks = text.match(/<task-notification>[\s\S]*?<\/task-notification>/gi);

  const parseBlock = (block: string): TaskStatusEntry | null => {
    const taskId = extractTagValue(block, ['task-id', 'task_id']);
    if (!taskId) return null;

    return {
      taskId,
      status: extractTagValue(block, ['status']),
      taskType: extractTagValue(block, ['task-type', 'task_type']),
      description: extractTagValue(block, ['summary', 'description']),
      source,
    };
  };

  if (notificationBlocks && notificationBlocks.length > 0) {
    for (const block of notificationBlocks) {
      const parsed = parseBlock(block);
      if (parsed) statuses.push(parsed);
    }
    return statuses;
  }

  const single = parseBlock(text);
  if (single) statuses.push(single);
  return statuses;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const block = item as Record<string, unknown>;
      return typeof block?.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function isTerminalTaskStatus(status?: string): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase().trim();
  return new Set([
    'completed',
    'complete',
    'success',
    'succeeded',
    'done',
    'failed',
    'error',
    'killed',
    'cancelled',
    'canceled',
    'timeout',
    'timed_out',
  ]).has(normalized);
}

function isCompletedTaskStatus(status?: string): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase().trim();
  return new Set(['completed', 'complete', 'success', 'succeeded', 'done']).has(normalized);
}

function extractUserTaskNotifications(messages: ClaudeMessage[]): TaskStatusEntry[] {
  const statuses: TaskStatusEntry[] = [];

  for (const msg of messages) {
    if (msg.type !== 'user') continue;
    const content = msg.message?.content;
    if (typeof content === 'string') {
      statuses.push(...extractTaskStatusesFromTaggedText(content, 'user_notification'));
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== 'text' || !block.text) continue;
      statuses.push(...extractTaskStatusesFromTaggedText(block.text, 'user_notification'));
    }
  }

  return statuses;
}

function extractTaskOutputStatuses(messages: ClaudeMessage[]): TaskStatusEntry[] {
  const statuses: TaskStatusEntry[] = [];
  const toolUseById = new Map<string, { name: string }>();

  for (const msg of messages) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        const id = block.id as string | undefined;
        const name = block.name as string | undefined;
        if (id && name) toolUseById.set(id, { name });
        continue;
      }

      if (block.type !== 'tool_result') continue;
      const toolUseId = block.tool_use_id as string | undefined;
      if (!toolUseId) continue;

      const toolUse = toolUseById.get(toolUseId);
      if (!toolUse || toolUse.name !== 'TaskOutput') continue;

      const text = extractToolResultText(block.content);
      if (!text) continue;
      statuses.push(...extractTaskStatusesFromTaggedText(text, 'task_output'));
    }
  }

  return statuses;
}

function extractTextFromUnknownContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const text = (item as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractAgentToolResults(messages: ClaudeMessage[]): AgentToolResultEntry[] {
  const entries: AgentToolResultEntry[] = [];
  const agentCalls = new Map<string, { description: string }>();

  for (const msg of messages) {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_use' || block.name !== 'Agent') continue;
        const id = typeof block.id === 'string' ? block.id : '';
        const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
        const description = typeof input.description === 'string' ? input.description : '';
        if (id) agentCalls.set(id, { description });
      }
    }

    const raw = msg as Record<string, unknown>;
    const toolUseResult = raw.toolUseResult;
    if (!toolUseResult || typeof toolUseResult !== 'object' || Array.isArray(toolUseResult)) continue;
    const resultRecord = toolUseResult as Record<string, unknown>;
    const agentId = typeof resultRecord.agentId === 'string' ? resultRecord.agentId : '';
    if (!agentId) continue;

    let description = typeof resultRecord.description === 'string' ? resultRecord.description : '';
    if (!description && typeof resultRecord.prompt === 'string') description = resultRecord.prompt.split('\n')[0] || '';
    if (!description && Array.isArray(content)) {
      const toolUseId = content
        .filter((block) => block.type === 'tool_result')
        .map((block) => (block as Record<string, unknown>).tool_use_id)
        .find((value): value is string => typeof value === 'string');
      description = toolUseId ? agentCalls.get(toolUseId)?.description || '' : '';
    }

    const outputFile = typeof resultRecord.outputFile === 'string' ? resultRecord.outputFile : undefined;
    const result = extractTextFromUnknownContent(resultRecord.content);
    const status = typeof resultRecord.status === 'string' ? resultRecord.status : undefined;
    entries.push({ agentId, description, status, outputFile, result });
  }

  return entries;
}

function normalizeSubagentStatus(
  status: string | undefined,
  fallback: 'completed' | 'killed',
): 'completed' | 'killed' | 'error' {
  if (!status) return fallback;
  const normalized = status.toLowerCase();
  if (isCompletedTaskStatus(normalized)) return 'completed';
  if (['error', 'failed', 'failure'].includes(normalized)) return 'error';
  if (['killed', 'cancelled', 'canceled', 'timeout', 'timed_out'].includes(normalized)) return 'killed';
  return fallback;
}

function resolveSubagentPath(sessionDir: string, taskId: string, outputFile?: string): string {
  const candidates: string[] = [];
  if (outputFile) {
    candidates.push(path.isAbsolute(outputFile) ? outputFile : path.join(sessionDir, outputFile));
  }
  candidates.push(path.join(sessionDir, 'subagents', `agent-${taskId}.jsonl`));
  candidates.push(path.join(sessionDir, 'subagents', `${taskId}.jsonl`));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const subagentsDir = path.join(sessionDir, 'subagents');
  try {
    if (fs.existsSync(subagentsDir)) {
      const match = fs.readdirSync(subagentsDir).find((entry) => entry.endsWith('.jsonl') && entry.includes(taskId));
      if (match) return path.join(subagentsDir, match);
    }
  } catch (err) {
    logger.debug('claude: failed to scan subagents dir', subagentsDir, err);
  }

  return candidates[0] || path.join(subagentsDir, `agent-${taskId}.jsonl`);
}

/**
 * Extract queue-operation events from messages.
 * Returns parsed entries with task_id, description, and operation type.
 */
function parseQueueOperations(messages: ClaudeMessage[]): QueueOperationEntry[] {
  const entries: QueueOperationEntry[] = [];
  for (const msg of messages) {
    if (msg.type !== 'queue-operation') continue;
    const raw = msg as Record<string, unknown>;
    const operation = (raw.operation as string) || '';
    const contentStr = (raw.content as string) || '';
    if (!contentStr) continue;

    // XML-style task notifications (or tagged task payloads) often appear here.
    const taggedStatuses = extractTaskStatusesFromTaggedText(contentStr, 'queue');
    if (taggedStatuses.length > 0) {
      for (const status of taggedStatuses) {
        entries.push({
          taskId: status.taskId,
          description: status.description || '',
          taskType: status.taskType,
          operation,
          status: status.status,
        });
      }
      continue;
    }

    try {
      const parsed = JSON.parse(contentStr) as Record<string, unknown>;
      const taskId = (parsed.task_id as string) || '';
      const description = (parsed.description as string) || '';
      if (taskId) {
        entries.push({
          taskId,
          description,
          taskType: (parsed.task_type as string) || undefined,
          operation,
          status: (parsed.status as string) || undefined,
        });
      }
    } catch {
      const taskId = contentStr.match(/"task_id"\s*:\s*"([^"]+)"/)?.[1];
      if (taskId) {
        entries.push({
          taskId,
          description: contentStr.match(/"description"\s*:\s*"([^"]+)"/)?.[1] || '',
          taskType: contentStr.match(/"task_type"\s*:\s*"([^"]+)"/)?.[1],
          operation,
        });
      } else {
        logger.debug('claude: malformed queue-operation content', contentStr.slice(0, 100));
      }
    }
  }
  return entries;
}

/**
 * Check if a message looks like a rate-limit or termination notice
 * rather than a real assistant response.
 */
function isTerminationMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('out of extra usage') ||
    lower.includes('rate limit') ||
    lower.includes('resets ') ||
    (text.length < 50 && (lower.includes('usage') || lower.includes('limit')))
  );
}

/**
 * Read a subagent JSONL file and return its final substantial assistant result.
 * Skips short termination/rate-limit messages to find the real output.
 * Returns null text if the file doesn't exist, is empty, or has no substantial result.
 */
async function extractSubagentResult(
  filePath: string,
): Promise<{ text: string | null; status: 'completed' | 'killed'; toolCallCount: number }> {
  try {
    if (!fs.existsSync(filePath)) {
      return { text: null, status: 'killed', toolCallCount: 0 };
    }

    const subMsgs = await readJsonlFile<ClaudeMessage>(filePath);
    let toolCallCount = 0;
    let lastSubstantialText: string | null = null;
    let wasKilled = false;

    for (const m of subMsgs) {
      if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        for (const block of m.message!.content) {
          if (typeof block === 'object' && block.type === 'tool_use') toolCallCount++;
        }
        const text = extractTextFromBlocks(m.message?.content);
        if (text && text.length > 50 && !isTerminationMessage(text)) {
          lastSubstantialText = text;
        }
        if (text && isTerminationMessage(text)) {
          wasKilled = true;
        }
      }
    }

    return {
      text: lastSubstantialText,
      status: wasKilled ? 'killed' : 'completed',
      toolCallCount,
    };
  } catch (err) {
    logger.debug('claude: failed to read subagent file', filePath, err);
    return { text: null, status: 'killed', toolCallCount: 0 };
  }
}

/**
 * Extract pending tasks from sequential-thinking / crash-think-tool blocks.
 * Looks for `next_action` in the input params of thinking tool_use blocks.
 */
function extractPendingFromThinking(messages: ClaudeMessage[], maxTasks: number): string[] {
  const tasks: string[] = [];
  const thinkingToolNames = new Set([
    'crash-think-tool',
    'must-use-think-tool-crash-crash',
    'sequential-thinking',
    'think',
  ]);

  // Walk backwards so we get the most recent thinking first
  for (let i = messages.length - 1; i >= 0 && tasks.length < maxTasks; i--) {
    const msg = messages[i];
    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (tasks.length >= maxTasks) break;
      if (block.type !== 'tool_use') continue;
      const name = (block as Record<string, unknown>).name as string;
      if (!thinkingToolNames.has(name)) continue;

      const input = (block as Record<string, unknown>).input as Record<string, unknown> | undefined;
      if (!input) continue;

      const nextAction = input.next_action as string | undefined;
      if (nextAction && typeof nextAction === 'string' && nextAction.length > 5) {
        // Avoid duplicates
        const trimmed = truncate(nextAction.trim(), 200);
        if (!tasks.includes(trimmed)) {
          tasks.push(trimmed);
        }
      }
    }
  }

  return tasks;
}

function hasCompactionCue(messages: ClaudeMessage[]): boolean {
  if (messages.some((m) => m.isCompactSummary)) return true;

  const continuationPattern =
    /(continued from a previous conversation|ran out of context|summary below covers|conversation compacted)/i;
  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue;
    const text = extractTextFromBlocks(msg.message?.content);
    if (text && continuationPattern.test(text)) return true;
  }

  return false;
}

async function extractLatestCompactSummary(filePath: string, maxChars: number): Promise<string | undefined> {
  const messages = await readJsonlFile<ClaudeMessage>(filePath);
  let compact: string | undefined;
  for (const msg of messages) {
    if (!msg.isCompactSummary || !msg.message?.content) continue;
    const text = extractTextFromBlocks(msg.message.content);
    if (text) compact = truncate(text, maxChars);
  }
  return compact;
}

async function resolvePreviousClaudeSessions(session: UnifiedSession, maxDepth: number): Promise<UnifiedSession[]> {
  if (maxDepth <= 0) return [];
  const allSessions = await parseClaudeSessions();
  const candidates = allSessions
    .filter((s) => s.id !== session.id && s.cwd === session.cwd)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const selected: UnifiedSession[] = [];
  const visited = new Set([session.id]);
  let cursorTime = session.createdAt.getTime() || session.updatedAt.getTime();

  for (const candidate of candidates) {
    if (selected.length >= maxDepth) break;
    if (visited.has(candidate.id)) continue;
    if (candidate.updatedAt.getTime() > cursorTime) continue;

    selected.push(candidate);
    visited.add(candidate.id);
    cursorTime = candidate.createdAt.getTime() || candidate.updatedAt.getTime();
  }

  return selected;
}

async function buildChainedHistoryPrefix(
  session: UnifiedSession,
  messages: ClaudeMessage[],
  cfg: VerbosityConfig,
): Promise<string | undefined> {
  if (!cfg.agents.claude.chainCompactedHistory) return undefined;
  if (!hasCompactionCue(messages)) return undefined;

  const previous = await resolvePreviousClaudeSessions(session, cfg.agents.claude.chainMaxDepth);
  if (previous.length === 0) return undefined;

  const lines: string[] = [
    '# Previous Session Chain Context',
    '',
    'The current Claude session appears compacted; best-effort predecessor sessions are included below.',
    '',
    '## Chained Previous Sessions',
    '',
  ];

  const ordered = [...previous].reverse(); // oldest → newest for readable timeline
  for (const [index, prev] of ordered.entries()) {
    lines.push(`### ${index + 1}. ${prev.id} (${prev.updatedAt.toISOString().slice(0, 16).replace('T', ' ')})`);
    lines.push(`- **Session file**: \`${safePath(prev.originalPath)}\``);
    if (prev.summary) {
      lines.push(`- **Summary**: ${truncate(prev.summary, cfg.agents.claude.chainSummaryChars)}`);
    }

    const compact = await extractLatestCompactSummary(prev.originalPath, cfg.agents.claude.chainSummaryChars);
    if (compact) {
      lines.push(`- **Compact summary**: ${compact}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Extract session notes from thinking blocks and model info
 */
function extractSessionNotes(messages: ClaudeMessage[], config?: VerbosityConfig): SessionNotes {
  const cfg = config ?? getPreset('standard');
  const notes: SessionNotes = {};

  // Extract model from first message that has it
  for (const msg of messages) {
    if (msg.model && !notes.model) {
      notes.model = msg.model;
      break;
    }
  }

  for (const msg of messages) {
    const raw = msg as Record<string, unknown>;
    const sourceMetadata: Record<string, unknown> = {};
    if (typeof raw.permissionMode === 'string') sourceMetadata.permissionMode = raw.permissionMode;
    if (typeof raw.version === 'string') sourceMetadata.version = raw.version;
    if (typeof raw.entrypoint === 'string') sourceMetadata.entrypoint = raw.entrypoint;
    if (typeof raw.userType === 'string') sourceMetadata.userType = raw.userType;
    if ((msg.uuid || msg.parentUuid) && !notes.sourceMetadata?.messageGraphSeen) {
      sourceMetadata.messageGraphSeen = true;
    }
    if (Object.keys(sourceMetadata).length > 0) {
      notes.sourceMetadata = { ...(notes.sourceMetadata ?? {}), ...sourceMetadata };
    }

    if (msg.type === 'file-history-snapshot') {
      const snapshot =
        raw.snapshot && typeof raw.snapshot === 'object' ? (raw.snapshot as Record<string, unknown>) : {};
      const messageId = typeof raw.messageId === 'string' ? raw.messageId : undefined;
      const snapshotMessageId = typeof snapshot.messageId === 'string' ? snapshot.messageId : undefined;
      const snapshotTimestamp = typeof snapshot.timestamp === 'string' ? snapshot.timestamp : undefined;
      const snapshotCwd = typeof snapshot.cwd === 'string' ? snapshot.cwd : undefined;
      const trackedFileBackups =
        snapshot.trackedFileBackups && typeof snapshot.trackedFileBackups === 'object'
          ? (snapshot.trackedFileBackups as Record<string, unknown>)
          : undefined;
      if (!notes.fileHistorySnapshots) notes.fileHistorySnapshots = [];
      notes.fileHistorySnapshots.push({
        ...(msg.timestamp || snapshotTimestamp ? { timestamp: msg.timestamp ?? snapshotTimestamp } : {}),
        ...(msg.cwd || snapshotCwd ? { cwd: msg.cwd ?? snapshotCwd } : {}),
        metadata: {
          ...(msg.uuid ? { uuid: msg.uuid } : {}),
          ...(msg.parentUuid ? { parentUuid: msg.parentUuid } : {}),
          ...(messageId ? { messageId } : {}),
          ...(snapshotMessageId ? { snapshotMessageId } : {}),
          ...(typeof raw.isSnapshotUpdate === 'boolean' ? { isSnapshotUpdate: raw.isSnapshotUpdate } : {}),
          ...(trackedFileBackups ? { trackedFileBackupsCount: Object.keys(trackedFileBackups).length } : {}),
        },
      });
    }

    const localCommandText = extractTextFromBlocks(msg.message?.content);
    if (
      msg.type === 'user' &&
      (localCommandText.includes('<local-command-stdout>') || localCommandText.includes('<command-name>'))
    ) {
      const localCommand = extractClaudeLocalCommandDetails(localCommandText);
      if (!notes.bootstrap) notes.bootstrap = [];
      notes.bootstrap.push({
        type: 'local_command',
        content: localCommand.content,
        ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
        metadata: {
          ...localCommand.metadata,
          ...(msg.uuid ? { uuid: msg.uuid } : {}),
          ...(msg.parentUuid ? { parentUuid: msg.parentUuid } : {}),
        },
      });
    }
  }

  // Aggregate token usage, cache tokens, and model from assistant messages
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    const msgObj = msg.message as Record<string, unknown> | undefined;
    if (!msgObj) continue;

    // Fallback: message.model carries the full model identifier from the API response
    if (msgObj.model && !notes.model) {
      notes.model = msgObj.model as string;
    }

    const usage = msgObj.usage as Record<string, number> | undefined;
    if (!usage) continue;

    if (!notes.tokenUsage) notes.tokenUsage = { input: 0, output: 0 };
    notes.tokenUsage.input += usage.input_tokens || 0;
    notes.tokenUsage.output += usage.output_tokens || 0;

    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    if (cacheCreation || cacheRead) {
      if (!notes.cacheTokens) notes.cacheTokens = { creation: 0, read: 0 };
      notes.cacheTokens.creation += cacheCreation;
      notes.cacheTokens.read += cacheRead;
    }
  }

  // Extract thinking highlights via shared utility
  const anthropicMsgs: AnthropicMessage[] = messages
    .filter((m) => m.message?.content && Array.isArray(m.message.content))
    .map((m) => ({
      role: m.message!.role,
      content: m.message!.content as Array<{ type: string; [key: string]: unknown }>,
    }));

  const reasoning = extractThinkingHighlights(anthropicMsgs, cfg.thinking.maxHighlights);
  if (reasoning.length > 0) notes.reasoning = reasoning;

  // Extract compact summary — take the LAST one (most comprehensive in long sessions)
  for (const msg of messages) {
    if (msg.isCompactSummary && msg.message?.content) {
      const text = extractTextFromBlocks(msg.message.content);
      if (text) {
        notes.compactSummary = truncate(text, cfg.compactSummary.maxChars);
      }
    }
  }

  return notes;
}

/**
 * Extract context from a Claude session for cross-tool continuation
 */
export async function extractClaudeContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const messages = await readJsonlFile<ClaudeMessage>(session.originalPath);
  // Extract tool data via shared utility
  const anthropicMsgs: AnthropicMessage[] = messages
    .filter((m) => m.message?.content && Array.isArray(m.message.content))
    .map((m) => ({
      role: m.message!.role,
      content: m.message!.content as Array<{ type: string; [key: string]: unknown }>,
    }));

  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs, cfg);
  const sessionNotes = extractSessionNotes(messages, cfg);
  const pendingTasks: string[] = [];

  // ── Extract reasoning steps from thinking tool blocks ─────────────────
  if (cfg.mcp.thinkingTools.extractReasoning) {
    const steps: ReasoningStep[] = [];
    for (const msg of anthropicMsgs) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          const tu = block as { type: string; name?: string; input?: Record<string, unknown> };
          if (tu.name && isThinkingTool(tu.name) && tu.input) {
            steps.push({
              stepNumber: (tu.input.step_number as number) || 0,
              totalSteps: (tu.input.estimated_total as number) || 0,
              purpose: String(tu.input.purpose || ''),
              thought: truncate(String(tu.input.thought || ''), cfg.mcp.thinkingTools.maxReasoningChars),
              outcome: truncate(String(tu.input.outcome || ''), cfg.mcp.thinkingTools.maxReasoningChars),
              nextAction: truncate(String(tu.input.next_action || ''), cfg.mcp.thinkingTools.maxReasoningChars),
            });
          }
        }
      }
    }
    if (steps.length > 0) {
      sessionNotes.reasoningSteps = steps;
    }
  }

  // ── Gap 5: Extract pending tasks from thinking tools ──────────────────
  if (cfg.pendingTasks.extractFromThinking) {
    const thinkingTasks = extractPendingFromThinking(messages, cfg.pendingTasks.maxTasks);
    pendingTasks.push(...thinkingTasks);
  }

  // ── Gap 1 + Gap 4: Filter to conversational messages before slicing ───
  // Gap 1: Filter out progress/system noise so we get real conversation turns
  // Gap 4: Optionally exclude user messages that are entirely tool_result blocks
  const conversational = messages.filter((m) => {
    if (m.type !== 'user' && m.type !== 'assistant') return false;
    if (isClaudeMetaMessage(m)) return false;
    if (m.isCompactSummary) return false;

    // Gap 4: When separateHumanFromToolResults is enabled, skip user messages
    // that contain only tool_result blocks (no human text)
    if (cfg.agents.claude.separateHumanFromToolResults && m.type === 'user') {
      if (!hasHumanTextBlocks(m)) return false;
    }

    return true;
  });

  const recentMessages: ConversationMessage[] = conversational.flatMap((msg) => {
    const content = stripClaudeLocalCommandMarkup(extractTextFromBlocks(msg.message?.content)).trim();
    if (!content) return [];
    const role: ConversationMessage['role'] = msg.type === 'user' ? 'user' : 'assistant';
    const rawTimestamp = getClaudeMessageTimestamp(msg);
    const timeMs = rawTimestamp ? Date.parse(rawTimestamp) : Number.NaN;
    return [
      {
        role,
        content,
        ...(Number.isFinite(timeMs) ? { timestamp: new Date(timeMs) } : {}),
        sourceId: msg.uuid,
        sourceParentId: msg.parentUuid,
      },
    ];
  });

  // ── Gap 2: Parse subagent JSONL files ─────────────────────────────────
  if (cfg.agents.claude.parseSubagents) {
    // Session dir = {project_dir}/{session_id}/ (not just dirname of the .jsonl)
    const sessionDir = session.originalPath.replace(/\.jsonl$/, '');
    const queueOps = parseQueueOperations(messages);
    const userTaskStatuses = extractUserTaskNotifications(messages);
    const taskOutputStatuses = extractTaskOutputStatuses(messages);
    const agentToolResults = extractAgentToolResults(messages);

    // Terminal states can come from queue ops, user task notifications, or TaskOutput payloads.
    const terminalTaskIds = new Set<string>();
    const completedTaskIds = new Set<string>();

    for (const op of queueOps) {
      if (op.operation !== 'enqueue') terminalTaskIds.add(op.taskId);
      if (isTerminalTaskStatus(op.status)) terminalTaskIds.add(op.taskId);
      if (isCompletedTaskStatus(op.status)) completedTaskIds.add(op.taskId);
    }

    for (const statusEntry of [...userTaskStatuses, ...taskOutputStatuses]) {
      if (isTerminalTaskStatus(statusEntry.status)) terminalTaskIds.add(statusEntry.taskId);
      if (isCompletedTaskStatus(statusEntry.status)) completedTaskIds.add(statusEntry.taskId);
    }

    // Deduplicate: keep only unique task_ids (first enqueue wins for description)
    const seen = new Set<string>();
    const uniqueTasks = queueOps.filter((op) => {
      if (op.operation !== 'enqueue') return false;
      if (seen.has(op.taskId)) return false;
      seen.add(op.taskId);
      return true;
    });

    let subagentCount = 0;
    const processedSubagents = new Set<string>();
    for (const task of uniqueTasks) {
      if (subagentCount >= cfg.task.maxSamples) break;
      // Only local_agent tasks are backed by subagent transcript files.
      if (task.taskType && task.taskType !== 'local_agent') continue;
      processedSubagents.add(task.taskId);

      const subagentPath = resolveSubagentPath(sessionDir, task.taskId);
      const { text, status: extractedStatus, toolCallCount } = await extractSubagentResult(subagentPath);
      const status = !text && completedTaskIds.has(task.taskId) ? 'completed' : extractedStatus;

      // Always populate structured subagentResults
      if (!sessionNotes.subagentResults) sessionNotes.subagentResults = [];
      sessionNotes.subagentResults.push({
        taskId: task.taskId,
        description: task.description,
        status,
        result: text ? truncate(text, cfg.task.subagentResultChars) : undefined,
        toolCallCount,
      });

      if (text) {
        // Legacy reasoning for markdown renderer
        if (!sessionNotes.reasoning) sessionNotes.reasoning = [];
        sessionNotes.reasoning.push(`Subagent "${task.description}": ${truncate(text, cfg.task.subagentResultChars)}`);
        subagentCount++;
      } else if (!terminalTaskIds.has(task.taskId)) {
        // Incomplete/killed subagent — add to pending tasks
        if (cfg.pendingTasks.extractFromSubagents && pendingTasks.length < cfg.pendingTasks.maxTasks) {
          pendingTasks.push(`Incomplete subagent: ${task.description}`);
        }
      }
    }

    for (const agent of agentToolResults) {
      if (subagentCount >= cfg.task.maxSamples) break;
      if (processedSubagents.has(agent.agentId)) continue;
      processedSubagents.add(agent.agentId);

      const subagentPath = resolveSubagentPath(sessionDir, agent.agentId, agent.outputFile);
      const { text, status: extractedStatus, toolCallCount } = await extractSubagentResult(subagentPath);
      const resultText = text || agent.result || undefined;
      const status = normalizeSubagentStatus(agent.status, resultText ? 'completed' : extractedStatus);
      const description = agent.description || `Agent ${agent.agentId}`;

      if (!sessionNotes.subagentResults) sessionNotes.subagentResults = [];
      sessionNotes.subagentResults.push({
        taskId: agent.agentId,
        description,
        status,
        result: resultText ? truncate(resultText, cfg.task.subagentResultChars) : undefined,
        toolCallCount,
      });

      if (resultText) {
        if (!sessionNotes.reasoning) sessionNotes.reasoning = [];
        sessionNotes.reasoning.push(`Subagent "${description}": ${truncate(resultText, cfg.task.subagentResultChars)}`);
        subagentCount++;
      } else if (!isTerminalTaskStatus(status)) {
        if (cfg.pendingTasks.extractFromSubagents && pendingTasks.length < cfg.pendingTasks.maxTasks) {
          pendingTasks.push(`Incomplete subagent: ${description}`);
        }
      }
    }
  }

  // ── Gap 3: Read tool-results directory ────────────────────────────────
  if (cfg.agents.claude.parseToolResultsDir) {
    const toolResultsSessionDir = session.originalPath.replace(/\.jsonl$/, '');
    const toolResultsPath = path.join(toolResultsSessionDir, 'tool-results');
    try {
      if (fs.existsSync(toolResultsPath)) {
        const entries = fs.readdirSync(toolResultsPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const filePath = path.join(toolResultsPath, entry.name);
          try {
            const stats = fs.statSync(filePath);
            const preview = fs.readFileSync(filePath, 'utf8').slice(0, 200);
            if (!sessionNotes.externalToolResults) sessionNotes.externalToolResults = [];
            sessionNotes.externalToolResults.push({
              name: entry.name,
              sizeBytes: stats.size,
              preview: preview.replace(/\n/g, ' ').trim(),
            });
            if (!sessionNotes.reasoning) sessionNotes.reasoning = [];
            sessionNotes.reasoning.push(`tool-result: ${entry.name} (${(stats.size / 1024).toFixed(1)} KB)`);
          } catch {
            // skip unreadable files
          }
        }
      }
    } catch (err) {
      logger.debug('claude: failed to read tool-results dir', toolResultsPath, err);
    }
  }

  const finalMessages = trimMessages(recentMessages, cfg.recentMessages);
  const timeline: SessionEvent[] = finalMessages.map((message, index) => ({
    kind: 'message',
    sequence: index,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    sourceId: message.sourceId,
    sourceParentId: message.sourceParentId,
  }));
  const dedupedPendingTasks = Array.from(new Set(pendingTasks)).slice(0, cfg.pendingTasks.maxTasks);

  const baseMarkdown = generateHandoffMarkdown(
    session,
    finalMessages,
    filesModified,
    dedupedPendingTasks,
    toolSummaries,
    sessionNotes,
    cfg,
    'inline',
    timeline,
  );
  const chainPrefix = await buildChainedHistoryPrefix(session, messages, cfg);
  const markdown = chainPrefix ? `${chainPrefix}\n\n---\n\n${baseMarkdown}` : baseMarkdown;

  return {
    session,
    recentMessages: finalMessages,
    filesModified,
    pendingTasks: dedupedPendingTasks,
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

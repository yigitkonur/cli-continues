import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  ReasoningStep,
  SessionContext,
  SessionEvent,
  SessionNotes,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import type { GeminiMessage, GeminiSession } from '../types/schemas.js';
import { GeminiMessageSchema, GeminiSessionSchema } from '../types/schemas.js';
import { classifyToolName } from '../types/tool-names.js';
import { extractTextFromBlocks } from '../utils/content.js';
import { findFiles, listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
import { fileSummary, mcpSummary, SummaryCollector, shellSummary, truncate } from '../utils/tool-summarizer.js';

const geminiHome = process.env.GEMINI_CLI_HOME || homeDir();
const GEMINI_BASE_DIR = path.join(geminiHome, '.gemini', 'tmp');
const GEMINI_LEGACY_DIR = path.join(geminiHome, '.gemini', 'sessions');
const GEMINI_PROJECTS_PATH = path.join(geminiHome, '.gemini', 'projects.json');

type GeminiSessionData = GeminiSession & {
  directories?: string[];
  summary?: string;
};

type GeminiJsonlRecord = Partial<GeminiSessionData> & {
  $rewindTo?: string;
  $set?: Partial<GeminiSessionData>;
};

/**
 * Find all Gemini session files (new and legacy storage formats)
 */
async function findSessionFiles(): Promise<string[]> {
  const results: string[] = [];

  // Current format: ~/.gemini/tmp/<project-hash>/chats/*.jsonl
  // Legacy chats path: ~/.gemini/tmp/<project-hash>/chats/session-*.json
  if (fs.existsSync(GEMINI_BASE_DIR)) {
    for (const projectDir of listSubdirectories(GEMINI_BASE_DIR)) {
      if (path.basename(projectDir) === 'bin') continue;
      const chatsDir = path.join(projectDir, 'chats');
      results.push(
        ...findFiles(chatsDir, {
          match: (entry) =>
            entry.name.endsWith('.jsonl') || (entry.name.startsWith('session-') && entry.name.endsWith('.json')),
          recursive: false,
        }),
      );
    }
  }

  // Legacy format: ~/.gemini/sessions/*.json
  if (fs.existsSync(GEMINI_LEGACY_DIR)) {
    results.push(
      ...findFiles(GEMINI_LEGACY_DIR, {
        match: (entry) => entry.name.endsWith('.json'),
        recursive: false,
      }),
    );
  }

  return results;
}

async function loadProjectDirectoryMap(): Promise<Map<string, string>> {
  try {
    const content = await fs.promises.readFile(GEMINI_PROJECTS_PATH, 'utf8');
    const parsed = JSON.parse(content) as { projects?: Record<string, string> };
    const entries = Object.entries(parsed.projects ?? {});
    return new Map(entries.map(([cwd, projectId]) => [projectId, cwd]));
  } catch (err) {
    logger.debug('gemini: failed to load projects.json mapping', GEMINI_PROJECTS_PATH, err);
    return new Map();
  }
}

async function countFileLines(filePath: string): Promise<number> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lines = 0;

  try {
    for await (const _line of rl) {
      lines++;
    }
    return lines;
  } finally {
    rl.close();
    stream.close();
  }
}

function toGeminiMessage(record: GeminiJsonlRecord): GeminiMessage | null {
  const result = GeminiMessageSchema.safeParse(record);
  if (result.success) return result.data;
  logger.debug('gemini: message validation failed', result.error.message);
  return null;
}

function getSessionDirectory(session: GeminiSessionData, projectDirectories: Map<string, string>): string {
  const metadataDirectory = session.directories?.find(
    (directory) => typeof directory === 'string' && directory.length > 0,
  );
  return metadataDirectory || projectDirectories.get(session.projectHash) || inferGeminiCwdFromToolPaths(session) || '';
}

function findRewindIndex(messages: GeminiMessage[], messageId: string): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.id === messageId) {
      return index;
    }
  }
  return -1;
}

async function parseJsonlSessionFile(filePath: string): Promise<GeminiSessionData | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  const sessionState: Partial<GeminiSessionData> = {};
  const messages: GeminiMessage[] = [];
  const messageIndexById = new Map<string, number>();

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      let record: GeminiJsonlRecord;
      try {
        record = JSON.parse(line) as GeminiJsonlRecord;
      } catch (err) {
        logger.debug('gemini: skipping malformed JSONL record', filePath, err);
        continue;
      }

      if (record.$set && typeof record.$set === 'object') {
        Object.assign(sessionState, record.$set);
        continue;
      }

      if (typeof record.$rewindTo === 'string') {
        const rewindIndex = findRewindIndex(messages, record.$rewindTo);
        if (rewindIndex >= 0) {
          messages.length = rewindIndex;
          for (const [messageId, index] of messageIndexById.entries()) {
            if (index >= rewindIndex) {
              messageIndexById.delete(messageId);
            }
          }
        }
        continue;
      }

      const message = toGeminiMessage(record);
      if (message) {
        if (message.id) {
          const existingIndex = messageIndexById.get(message.id);
          if (existingIndex !== undefined) {
            messages[existingIndex] = message;
          } else {
            messageIndexById.set(message.id, messages.length);
            messages.push(message);
          }
        } else {
          messages.push(message);
        }
        continue;
      }

      Object.assign(sessionState, record);
    }
  } finally {
    rl.close();
    stream.close();
  }

  const parsed = GeminiSessionSchema.safeParse({
    sessionId: sessionState.sessionId,
    projectHash: sessionState.projectHash,
    startTime: sessionState.startTime,
    lastUpdated: sessionState.lastUpdated,
    messages,
  });

  if (!parsed.success) {
    logger.debug('gemini: JSONL session validation failed', filePath, parsed.error.message);
    return null;
  }

  return {
    ...parsed.data,
    ...(typeof sessionState.summary === 'string' ? { summary: sessionState.summary } : {}),
    ...(Array.isArray(sessionState.directories)
      ? {
          directories: sessionState.directories.filter(
            (directory): directory is string => typeof directory === 'string' && directory.length > 0,
          ),
        }
      : {}),
  };
}

/**
 * Parse a single Gemini session file
 */
async function parseSessionFile(filePath: string): Promise<GeminiSessionData | null> {
  try {
    if (filePath.endsWith('.jsonl')) {
      return await parseJsonlSessionFile(filePath);
    }

    const content = await fs.promises.readFile(filePath, 'utf8');
    const result = GeminiSessionSchema.safeParse(JSON.parse(content));
    if (result.success) return result.data;
    logger.debug('gemini: session validation failed', filePath, result.error.message);
    return null;
  } catch (err) {
    logger.debug('gemini: failed to parse session file', filePath, err);
    return null;
  }
}

/**
 * Extract text content from Gemini message (handles both string and array formats)
 */
function extractGeminiContent(content: string | Array<{ text?: string; type?: string }>): string {
  return extractTextFromBlocks(content as string | Array<{ type: string; text?: string }>);
}

type GeminiResultDisplayObject = Exclude<NonNullable<GeminiMessage['toolCalls']>[number]['resultDisplay'], string>;

function getGeminiResultDisplayObject(
  value: NonNullable<GeminiMessage['toolCalls']>[number]['resultDisplay'],
): GeminiResultDisplayObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function getGeminiResultDisplayText(value: NonNullable<GeminiMessage['toolCalls']>[number]['resultDisplay']): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.fileDiff || value.newContent || value.originalContent || '';
}

function getGeminiToolResultText(tc: NonNullable<GeminiMessage['toolCalls']>[number]): string {
  const response = tc.result?.[0]?.functionResponse?.response;
  return response?.output || response?.error || getGeminiResultDisplayText(tc.resultDisplay);
}

function getGeminiToolFilePath(tc: NonNullable<GeminiMessage['toolCalls']>[number]): string {
  const resultDisplay = getGeminiResultDisplayObject(tc.resultDisplay);
  if (typeof resultDisplay?.filePath === 'string') return resultDisplay.filePath;
  const argFilePath = tc.args?.file_path;
  if (typeof argFilePath === 'string') return argFilePath;
  const argPath = tc.args?.path;
  if (typeof argPath === 'string') return argPath;
  return '';
}

function inferGeminiCwdFromToolPaths(session: GeminiSessionData): string {
  for (const msg of session.messages) {
    if (msg.type !== 'gemini' || !msg.toolCalls) continue;
    for (const toolCall of msg.toolCalls) {
      const filePath = getGeminiToolFilePath(toolCall);
      if (path.isAbsolute(filePath)) return path.dirname(filePath);
    }
  }
  return '';
}

/**
 * Extract first real user message from Gemini session
 */
function extractFirstUserMessage(session: GeminiSession): string {
  for (const msg of session.messages) {
    if (msg.type === 'user' && msg.content) {
      return extractGeminiContent(msg.content);
    }
  }
  return '';
}

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector
 */
function extractToolData(
  sessionData: GeminiSession,
  config?: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);

  for (const msg of sessionData.messages) {
    if (msg.type !== 'gemini' || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      const { name, args, resultDisplay, status } = tc;
      const display = getGeminiResultDisplayObject(resultDisplay);
      const category = classifyToolName(name);
      if (!category) continue; // skip internal tools

      const fp = getGeminiToolFilePath(tc);
      const resultStr = getGeminiToolResultText(tc);
      const isError = status ? !['ok', 'success', 'completed'].includes(status.toLowerCase()) : false;

      switch (category) {
        case 'write': {
          let diffStat: { added: number; removed: number } | undefined;
          if (display?.diffStat) {
            diffStat = {
              added: display.diffStat.model_added_lines || 0,
              removed: display.diffStat.model_removed_lines || 0,
            };
          } else if (display?.fileDiff) {
            const lines = display.fileDiff.split('\n');
            diffStat = {
              added: lines.filter((l: string) => l.startsWith('+')).length,
              removed: lines.filter((l: string) => l.startsWith('-')).length,
            };
          }
          const isNewFile = display?.isNewFile ?? false;
          const diff = display?.fileDiff || undefined;
          collector.add(name, fileSummary('write', fp, diffStat, isNewFile), {
            data: {
              category: 'write',
              filePath: fp,
              isNewFile,
              ...(diff ? { diff } : {}),
              ...(diffStat ? { diffStats: diffStat } : {}),
            },
            filePath: fp,
            isWrite: true,
            isError,
          });
          break;
        }
        case 'read':
          collector.add(name, fileSummary('read', fp), {
            data: { category: 'read', filePath: fp },
            filePath: fp,
            isError,
          });
          if (fp) collector.trackFile(fp);
          break;
        case 'shell': {
          const cmd = (args?.command as string) || (args?.cmd as string) || '';
          const output = resultStr ? String(resultStr) : '';
          collector.add(name, shellSummary(cmd, output || undefined), {
            data: { category: 'shell', command: cmd, ...(output ? { stdoutTail: output.slice(-500) } : {}) },
            isError,
          });
          break;
        }
        case 'edit': {
          let diffStat: { added: number; removed: number } | undefined;
          if (display?.diffStat) {
            diffStat = {
              added: display.diffStat.model_added_lines || 0,
              removed: display.diffStat.model_removed_lines || 0,
            };
          } else if (display?.fileDiff) {
            const dLines = display.fileDiff.split('\n');
            diffStat = {
              added: dLines.filter((l: string) => l.startsWith('+')).length,
              removed: dLines.filter((l: string) => l.startsWith('-')).length,
            };
          }
          const diff = display?.fileDiff || undefined;
          collector.add(name, fileSummary('edit', fp, diffStat), {
            data: {
              category: 'edit',
              filePath: fp,
              ...(diff ? { diff } : {}),
              ...(diffStat ? { diffStats: diffStat } : {}),
            },
            filePath: fp,
            isWrite: true,
            isError,
          });
          break;
        }
        case 'grep': {
          const pattern = (args?.pattern as string) || (args?.query as string) || '';
          collector.add(name, `grep "${truncate(pattern, 40)}"`, {
            data: { category: 'grep', pattern, ...(fp ? { targetPath: fp } : {}) },
            isError,
          });
          break;
        }
        case 'glob': {
          const pattern = (args?.pattern as string) || fp;
          collector.add(name, `glob ${truncate(pattern, 50)}`, {
            data: { category: 'glob', pattern },
            isError,
          });
          break;
        }
        case 'search':
          collector.add(name, `search "${truncate((args?.query as string) || '', 50)}"`, {
            data: { category: 'search', query: (args?.query as string) || '' },
            isError,
          });
          break;
        case 'fetch':
          collector.add(name, `fetch ${truncate((args?.url as string) || '', 60)}`, {
            data: {
              category: 'fetch',
              url: (args?.url as string) || '',
              ...(resultStr ? { resultPreview: String(resultStr).slice(0, 100) } : {}),
            },
            isError,
          });
          break;
        case 'task': {
          const desc = (args?.description as string) || (args?.prompt as string) || '';
          const agentType = (args?.subagent_type as string) || undefined;
          collector.add(name, `task "${truncate(desc, 60)}"${agentType ? ` (${agentType})` : ''}`, {
            data: { category: 'task', description: desc, ...(agentType ? { agentType } : {}) },
            isError,
          });
          break;
        }
        case 'ask': {
          const question = truncate((args?.question as string) || (args?.prompt as string) || '', 80);
          collector.add(name, `ask: "${question}"`, {
            data: { category: 'ask', question },
            isError,
          });
          break;
        }
        default: {
          // mcp — fallback to compact format
          const argsStr = args ? JSON.stringify(args).slice(0, 100) : '';
          collector.add(name, mcpSummary(name, argsStr, resultStr), {
            data: {
              category: 'mcp',
              toolName: name,
              ...(argsStr ? { params: argsStr } : {}),
              ...(resultStr ? { result: String(resultStr).slice(0, 100) } : {}),
            },
            isError,
          });
        }
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes from thoughts, model info, and token usage
 */
function extractSessionNotes(sessionData: GeminiSession): SessionNotes {
  const notes: SessionNotes = {};
  const reasoningSteps: ReasoningStep[] = [];

  for (const msg of sessionData.messages) {
    if (msg.type !== 'gemini') continue;

    if (msg.model && !notes.model) notes.model = msg.model;

    if (msg.tokens) {
      if (!notes.tokenUsage) notes.tokenUsage = { input: 0, output: 0 };
      notes.tokenUsage.input += msg.tokens.input || 0;
      notes.tokenUsage.output += msg.tokens.output || 0;

      // Accumulate cache and thinking tokens
      if (msg.tokens.cached) {
        if (!notes.cacheTokens) notes.cacheTokens = { creation: 0, read: 0 };
        notes.cacheTokens.read += msg.tokens.cached;
      }
      if (msg.tokens.thoughts) {
        notes.thinkingTokens = (notes.thinkingTokens || 0) + msg.tokens.thoughts;
      }
    }

    if (msg.thoughts && reasoningSteps.length < 10) {
      for (const thought of msg.thoughts) {
        if (reasoningSteps.length >= 10) break;
        const text = thought.description || thought.subject || '';
        if (text.length > 10) {
          reasoningSteps.push({
            stepNumber: reasoningSteps.length + 1,
            totalSteps: msg.thoughts.length,
            purpose: 'analysis',
            thought: truncate(text, 200),
            outcome: '',
            nextAction: '',
          });
        }
      }
    }
  }

  if (reasoningSteps.length > 0) {
    // Backfill totalSteps with the final count so each step's stepNumber/totalSteps
    // pair stays internally consistent (the inner loop only knew the per-message
    // thought count, which made later steps render as "step N/M" with an outdated M).
    const finalCount = reasoningSteps.length;
    for (const step of reasoningSteps) {
      step.totalSteps = finalCount;
    }
    notes.reasoningSteps = reasoningSteps;
  }
  return notes;
}

/**
 * Parse all Gemini sessions
 */
export async function parseGeminiSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const projectDirectories = await loadProjectDirectoryMap();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const session = await parseSessionFile(filePath);
      if (!session || !session.sessionId) continue;

      const firstUserMessage = extractFirstUserMessage(session);
      const summary = cleanSummary(session.summary || firstUserMessage);

      const fileStats = await fs.promises.stat(filePath);
      const lines = await countFileLines(filePath);
      const cwd = getSessionDirectory(session, projectDirectories);

      sessions.push({
        id: session.sessionId,
        source: 'gemini',
        cwd,
        repo: '',
        lines,
        bytes: fileStats.size,
        createdAt: new Date(session.startTime),
        updatedAt: new Date(session.lastUpdated),
        originalPath: filePath,
        summary: summary || undefined,
      });
    } catch (err) {
      logger.debug('gemini: skipping unparseable session', filePath, err);
      // Skip files we can't parse
    }
  }

  // Filter sessions that have real user messages (not just auth flows)
  return sessions
    .filter((s) => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Gemini session for cross-tool continuation
 */
export async function extractGeminiContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const sessionData = await parseSessionFile(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  let filesModified: string[] = [];
  const pendingTasks: string[] = [];
  let toolSummaries: ToolUsageSummary[] = [];
  let sessionNotes: SessionNotes | undefined;
  const timeline: SessionEvent[] = [];
  let sequence = 0;

  if (sessionData) {
    const toolData = extractToolData(sessionData, resolvedConfig);
    toolSummaries = toolData.summaries;
    filesModified = toolData.filesModified;
    sessionNotes = extractSessionNotes(sessionData);

    for (const msg of sessionData.messages) {
      // Extract pending tasks from thoughts
      if (msg.type === 'gemini' && msg.thoughts && pendingTasks.length < 5) {
        for (const thought of msg.thoughts) {
          if (pendingTasks.length >= 5) break;
          const subject = thought.subject?.toLowerCase() || '';
          const description = thought.description?.toLowerCase() || '';
          if (
            subject.includes('todo') ||
            subject.includes('next') ||
            subject.includes('remaining') ||
            subject.includes('need to') ||
            description.includes('need to') ||
            description.includes('next step')
          ) {
            const taskText = thought.subject || thought.description || '';
            if (taskText && taskText.length > 0) pendingTasks.push(taskText);
          }
        }
      }

      if (msg.type === 'user') {
        const content = extractGeminiContent(msg.content);
        recentMessages.push({
          role: 'user',
          content,
          timestamp: new Date(msg.timestamp),
          sourceId: msg.id,
        });
        timeline.push({
          kind: 'message',
          sequence: sequence++,
          role: 'user',
          content,
          timestamp: new Date(msg.timestamp),
          sourceId: msg.id,
        });
      } else if (msg.type === 'gemini') {
        const textContent = extractGeminiContent(msg.content);
        if (textContent) {
          recentMessages.push({
            role: 'assistant',
            content: textContent,
            timestamp: new Date(msg.timestamp),
            sourceId: msg.id,
          });
          timeline.push({
            kind: 'message',
            sequence: sequence++,
            role: 'assistant',
            content: textContent,
            timestamp: new Date(msg.timestamp),
            sourceId: msg.id,
          });
        } else if (msg.toolCalls && msg.toolCalls.length > 0) {
          recentMessages.push({
            role: 'assistant',
            content: `[Used tools: ${msg.toolCalls.map((toolCall) => toolCall.name).join(', ')}]`,
            timestamp: new Date(msg.timestamp),
            sourceId: msg.id,
            toolCalls: msg.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.args,
              result: getGeminiToolResultText(toolCall) || undefined,
              success: toolCall.status
                ? ['ok', 'success', 'completed'].includes(toolCall.status.toLowerCase())
                : undefined,
            })),
          });
        }

        for (const toolCall of msg.toolCalls ?? []) {
          timeline.push({
            kind: 'tool_call',
            sequence: sequence++,
            timestamp: toolCall.timestamp ? new Date(toolCall.timestamp) : new Date(msg.timestamp),
            sourceId: msg.id,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            status: toolCall.status,
            arguments: toolCall.args,
            result: getGeminiToolResultText(toolCall) || undefined,
            filePaths: getGeminiToolFilePath(toolCall) ? [getGeminiToolFilePath(toolCall)] : undefined,
          });
        }
      } else if (['info', 'warning', 'error'].includes(msg.type)) {
        const content = extractGeminiContent(msg.content);
        if (content) {
          recentMessages.push({
            role: 'system',
            content,
            timestamp: new Date(msg.timestamp),
            sourceId: msg.id,
          });
          timeline.push({
            kind: msg.type === 'info' ? 'metadata' : 'warning',
            sequence: sequence++,
            timestamp: new Date(msg.timestamp),
            sourceId: msg.id,
            status: msg.type,
            content,
          });
        }
      }
    }
  }

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);

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
    session: sessionNotes?.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

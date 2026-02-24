import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import type { GeminiSession } from '../types/schemas.js';
import { GeminiSessionSchema } from '../types/schemas.js';
import { extractTextFromBlocks } from '../utils/content.js';
import { findFiles, listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
import { classifyToolName } from '../types/tool-names.js';
import { fileSummary, mcpSummary, shellSummary, SummaryCollector, truncate } from '../utils/tool-summarizer.js';

const GEMINI_BASE_DIR = path.join(homeDir(), '.gemini', 'tmp');

/**
 * Find all Gemini session files
 */
async function findSessionFiles(): Promise<string[]> {
  if (!fs.existsSync(GEMINI_BASE_DIR)) return [];

  const results: string[] = [];
  for (const projectDir of listSubdirectories(GEMINI_BASE_DIR)) {
    if (path.basename(projectDir) === 'bin') continue;
    const chatsDir = path.join(projectDir, 'chats');
    results.push(
      ...findFiles(chatsDir, {
        match: (entry) => entry.name.startsWith('session-') && entry.name.endsWith('.json'),
        recursive: false,
      }),
    );
  }
  return results;
}

/**
 * Parse a single Gemini session file
 */
function parseSessionFile(filePath: string): GeminiSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
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
function extractToolData(sessionData: GeminiSession): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector();

  for (const msg of sessionData.messages) {
    if (msg.type !== 'gemini' || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      const { name, args, result, resultDisplay, status } = tc;
      const category = classifyToolName(name);
      if (!category) continue; // skip internal tools

      const fp = resultDisplay?.filePath || (args?.file_path as string) || (args?.path as string) || '';
      const resultStr = result?.[0]?.functionResponse?.response?.output;
      const isError = status ? !['ok', 'success', 'completed'].includes(status.toLowerCase()) : false;

      switch (category) {
        case 'write': {
          let diffStat: { added: number; removed: number } | undefined;
          if (resultDisplay?.diffStat) {
            diffStat = {
              added: resultDisplay.diffStat.model_added_lines || 0,
              removed: resultDisplay.diffStat.model_removed_lines || 0,
            };
          } else if (resultDisplay?.fileDiff) {
            const lines = resultDisplay.fileDiff.split('\n');
            diffStat = {
              added: lines.filter((l: string) => l.startsWith('+')).length,
              removed: lines.filter((l: string) => l.startsWith('-')).length,
            };
          }
          const isNewFile = resultDisplay?.isNewFile ?? false;
          const diff = resultDisplay?.fileDiff || undefined;
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
          if (resultDisplay?.diffStat) {
            diffStat = {
              added: resultDisplay.diffStat.model_added_lines || 0,
              removed: resultDisplay.diffStat.model_removed_lines || 0,
            };
          } else if (resultDisplay?.fileDiff) {
            const dLines = resultDisplay.fileDiff.split('\n');
            diffStat = {
              added: dLines.filter((l: string) => l.startsWith('+')).length,
              removed: dLines.filter((l: string) => l.startsWith('-')).length,
            };
          }
          const diff = resultDisplay?.fileDiff || undefined;
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
  const reasoning: string[] = [];

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

    if (msg.thoughts && reasoning.length < 5) {
      for (const thought of msg.thoughts) {
        if (reasoning.length >= 5) break;
        const text = thought.description || thought.subject || '';
        if (text.length > 10) reasoning.push(truncate(text, 200));
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Parse all Gemini sessions
 */
export async function parseGeminiSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const session = parseSessionFile(filePath);
      if (!session || !session.sessionId) continue;

      // Get cwd from parent directory structure (project hash dir)
      const projectHashDir = path.dirname(path.dirname(filePath));
      const projectHash = path.basename(projectHashDir);

      // Gemini does not store working directory in its session data
      const cwd = '';

      const firstUserMessage = extractFirstUserMessage(session);
      const summary = cleanSummary(firstUserMessage);

      const fileStats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').length;

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
export async function extractGeminiContext(session: UnifiedSession): Promise<SessionContext> {
  const sessionData = parseSessionFile(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  let filesModified: string[] = [];
  const pendingTasks: string[] = [];
  let toolSummaries: ToolUsageSummary[] = [];
  let sessionNotes: SessionNotes | undefined;

  if (sessionData) {
    const toolData = extractToolData(sessionData);
    toolSummaries = toolData.summaries;
    filesModified = toolData.filesModified;
    sessionNotes = extractSessionNotes(sessionData);

    for (const msg of sessionData.messages.slice(-20)) {
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
        recentMessages.push({
          role: 'user',
          content: extractGeminiContent(msg.content),
          timestamp: new Date(msg.timestamp),
        });
      } else if (msg.type === 'gemini') {
        const textContent = extractGeminiContent(msg.content);
        if (textContent) {
          recentMessages.push({
            role: 'assistant',
            content: textContent,
            timestamp: new Date(msg.timestamp),
          });
        }
      }
    }
  }

  const markdown = generateHandoffMarkdown(
    session,
    recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
  );

  return {
    session: sessionNotes?.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

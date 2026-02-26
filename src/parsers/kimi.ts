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
import type { KimiMetadata, KimiMessage } from '../types/schemas.js';
import { KimiMetadataSchema } from '../types/schemas.js';
import { extractTextFromBlocks } from '../utils/content.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { readJsonlFile } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
import { classifyToolName } from '../types/tool-names.js';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { fileSummary, mcpSummary, shellSummary, SummaryCollector, truncate } from '../utils/tool-summarizer.js';

const KIMI_SESSIONS_DIR = path.join(homeDir(), '.kimi', 'sessions');

/**
 * Find all Kimi session directories
 */
async function findSessionDirs(): Promise<string[]> {
  const results: string[] = [];

  if (!fs.existsSync(KIMI_SESSIONS_DIR)) {
    return results;
  }

  // Kimi stores sessions as: ~/.kimi/sessions/{workdir_hash}/{session_id}/
  for (const workdirDir of listSubdirectories(KIMI_SESSIONS_DIR)) {
    for (const sessionDir of listSubdirectories(workdirDir)) {
      const metadataPath = path.join(sessionDir, 'metadata.json');
      const contextPath = path.join(sessionDir, 'context.jsonl');
      if (fs.existsSync(metadataPath) && fs.existsSync(contextPath)) {
        results.push(sessionDir);
      }
    }
  }

  return results;
}

/**
 * Parse metadata.json from a Kimi session directory
 */
function parseMetadata(sessionDir: string): KimiMetadata | null {
  try {
    const metadataPath = path.join(sessionDir, 'metadata.json');
    const content = fs.readFileSync(metadataPath, 'utf8');
    const result = KimiMetadataSchema.safeParse(JSON.parse(content));
    if (result.success) return result.data;
    logger.debug('kimi: metadata validation failed', sessionDir, result.error.message);
    return null;
  } catch (err) {
    logger.debug('kimi: failed to parse metadata', sessionDir, err);
    return null;
  }
}

/**
 * Read context.jsonl from a Kimi session directory
 */
async function readContextFile(sessionDir: string): Promise<KimiMessage[]> {
  try {
    const contextPath = path.join(sessionDir, 'context.jsonl');
    return await readJsonlFile<KimiMessage>(contextPath);
  } catch (err) {
    logger.debug('kimi: failed to read context', sessionDir, err);
    return [];
  }
}

/**
 * Extract text content from Kimi message (handles both string and array formats)
 */
function extractKimiContent(content: string | Array<{ text?: string; type?: string }>): string {
  return extractTextFromBlocks(content as string | Array<{ type: string; text?: string }>);
}

/**
 * Extract first real user message from Kimi messages
 */
function extractFirstUserMessage(messages: KimiMessage[]): string {
  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return '';
}

/**
 * Parse tool call arguments safely
 */
function parseToolArgs(argsStr: string): Record<string, unknown> {
  try {
    return JSON.parse(argsStr);
  } catch {
    return {};
  }
}

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector
 */
function extractToolData(messages: KimiMessage[], config?: VerbosityConfig): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      const args = parseToolArgs(tc.function.arguments);
      const category = classifyToolName(name);
      if (!category) continue; // skip internal tools

      const fp = (args.file_path as string) || (args.path as string) || '';

      switch (category) {
        case 'write': {
          collector.add(
            name,
            fileSummary('write', fp, undefined, false),
            { data: { category: 'write', filePath: fp }, filePath: fp, isWrite: true }
          );
          break;
        }
        case 'read':
          collector.add(name, fileSummary('read', fp), {
            data: { category: 'read', filePath: fp },
            filePath: fp,
          });
          break;
        case 'shell': {
          const cmd = (args.command as string) || (args.cmd as string) || '';
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
          const pattern = (args.pattern as string) || (args.query as string) || '';
          collector.add(name, `grep "${truncate(pattern, 40)}"`, {
            data: { category: 'grep', pattern, ...(fp ? { targetPath: fp } : {}) },
          });
          break;
        }
        case 'glob': {
          const pattern = (args.pattern as string) || fp;
          collector.add(name, `glob ${truncate(pattern, 50)}`, {
            data: { category: 'glob', pattern },
          });
          break;
        }
        case 'search':
          collector.add(name, `search "${truncate((args.query as string) || '', 50)}"`, {
            data: { category: 'search', query: (args.query as string) || '' },
          });
          break;
        case 'fetch':
          collector.add(name, `fetch ${truncate((args.url as string) || '', 60)}`, {
            data: { category: 'fetch', url: (args.url as string) || '' },
          });
          break;
        case 'task': {
          const desc = (args.description as string) || (args.prompt as string) || '';
          const agentType = (args.subagent_type as string) || undefined;
          collector.add(name, `task "${truncate(desc, 60)}"${agentType ? ` (${agentType})` : ''}`, {
            data: { category: 'task', description: desc, ...(agentType ? { agentType } : {}) },
          });
          break;
        }
        case 'ask': {
          const question = truncate((args.question as string) || (args.prompt as string) || '', 80);
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

/**
 * Extract session notes (thinking blocks, token usage)
 */
function extractSessionNotes(messages: KimiMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];
  let totalTokens = 0;

  for (const msg of messages) {
    // Extract thinking blocks from assistant messages
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'think' && block.think) {
          const thought = String(block.think).trim();
          if (thought.length > 10 && reasoning.length < 5) {
            reasoning.push(truncate(thought, 200));
          }
        }
      }
    }

    // Extract usage info from _usage entries
    if (msg.role === '_usage' && 'token_count' in msg) {
      totalTokens += (msg as unknown as { token_count: number }).token_count;
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  if (totalTokens > 0) notes.tokenUsage = { input: Math.floor(totalTokens * 0.7), output: Math.floor(totalTokens * 0.3) };

  return notes;
}

/**
 * Parse all Kimi sessions
 */
export async function parseKimiSessions(): Promise<UnifiedSession[]> {
  const sessionDirs = await findSessionDirs();
  const sessions: UnifiedSession[] = [];

  for (const sessionDir of sessionDirs) {
    try {
      const metadata = parseMetadata(sessionDir);
      if (!metadata || metadata.archived) continue;

      const messages = await readContextFile(sessionDir);
      if (messages.length === 0) continue;

      const firstUserMessage = extractFirstUserMessage(messages);
      const summary = cleanSummary(firstUserMessage);

      // Get file stats for timestamps
      const metadataPath = path.join(sessionDir, 'metadata.json');
      const stats = fs.statSync(metadataPath);

      // Try to get working directory from kimi.json
      let cwd = '';
      try {
        const kimiConfigPath = path.join(homeDir(), '.kimi', 'kimi.json');
        if (fs.existsSync(kimiConfigPath)) {
          const config = JSON.parse(fs.readFileSync(kimiConfigPath, 'utf8'));
          const workDirHash = path.basename(path.dirname(sessionDir));
          const match = config.work_dirs?.find((wd: { path: string }) => {
            // Simple hash matching - the hash is a simple hash of the path
            const pathHash = Buffer.from(wd.path).toString('base64').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 32);
            return pathHash === workDirHash || sessionDir.includes(workDirHash);
          });
          if (match) cwd = match.path;
        }
      } catch {
        // Ignore errors reading config
      }

      sessions.push({
        id: metadata.session_id,
        source: 'kimi',
        cwd,
        repo: '',
        lines: messages.length,
        bytes: fs.statSync(path.join(sessionDir, 'context.jsonl')).size,
        createdAt: stats.birthtime,
        updatedAt: new Date((metadata.wire_mtime || Date.now() / 1000) * 1000),
        originalPath: sessionDir,
        summary: summary || metadata.title || undefined,
      });
    } catch (err) {
      logger.debug('kimi: skipping unparseable session', sessionDir, err);
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
  const messages = await readContextFile(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  const pendingTasks: string[] = [];

  const toolData = extractToolData(messages, resolvedConfig);
  const sessionNotes = extractSessionNotes(messages);

  // Extract recent conversation messages
  let messageCount = 0;
  for (let i = messages.length - 1; i >= 0 && messageCount < resolvedConfig.recentMessages * 2; i--) {
    const msg = messages[i];

    if (msg.role === 'user' && typeof msg.content === 'string') {
      recentMessages.unshift({
        role: 'user',
        content: msg.content,
      });
      messageCount++;
    } else if (msg.role === 'assistant') {
      const content = extractKimiContent(msg.content);
      if (content) {
        recentMessages.unshift({
          role: 'assistant',
          content,
        });
        messageCount++;
      }

      // Extract pending tasks from thinking blocks
      if (Array.isArray(msg.content) && pendingTasks.length < 5) {
        for (const block of msg.content) {
          if (block.type === 'think' && block.think) {
            const thought = String(block.think).toLowerCase();
            if (
              thought.includes('need to') ||
              thought.includes('next step') ||
              thought.includes('todo') ||
              thought.includes('remaining')
            ) {
              const taskText = String(block.think).trim();
              if (taskText.length > 0 && !pendingTasks.includes(taskText)) {
                pendingTasks.push(taskText);
              }
            }
          }
        }
      }
    }
  }

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);

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

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionNotes, UnifiedSession } from '../types/index.js';
import type { ClaudeMessage } from '../types/schemas.js';
import { extractTextFromBlocks, isRealUserMessage } from '../utils/content.js';
import { findFiles } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';
import { truncate } from '../utils/tool-summarizer.js';

const CLAUDE_PROJECTS_DIR = path.join(homeDir(), '.claude', 'projects');

/**
 * Find all Claude session files recursively
 */
async function findSessionFiles(): Promise<string[]> {
  return findFiles(CLAUDE_PROJECTS_DIR, {
    match: (entry) =>
      entry.name.endsWith('.jsonl') &&
      !entry.name.includes('debug') &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(entry.name),
  });
}

/**
 * Parse session metadata and first user message
 */
async function parseSessionInfo(filePath: string): Promise<{
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  firstUserMessage: string;
}> {
  let sessionId = '';
  let cwd = '';
  let gitBranch = '';
  let firstUserMessage = '';

  await scanJsonlHead(filePath, 50, (parsed) => {
    const msg = parsed as ClaudeMessage;
    if (msg.sessionId && !sessionId) sessionId = msg.sessionId;
    if (msg.cwd && !cwd) cwd = msg.cwd;
    if (msg.gitBranch && !gitBranch) gitBranch = msg.gitBranch;

    if (!firstUserMessage && msg.type === 'user' && msg.message?.content) {
      const content = extractTextFromBlocks(msg.message.content);
      if (isRealUserMessage(content)) {
        firstUserMessage = content;
      }
    }
    return 'continue';
  });

  if (!sessionId) {
    sessionId = path.basename(filePath, '.jsonl');
  }

  return { sessionId, cwd, gitBranch, firstUserMessage };
}

/**
 * Parse all Claude sessions
 */
export async function parseClaudeSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const info = await parseSessionInfo(filePath);
      const stats = await getFileStats(filePath);
      const fileStats = fs.statSync(filePath);

      const summary = cleanSummary(info.firstUserMessage);
      const repo = extractRepoFromCwd(info.cwd);

      sessions.push({
        id: info.sessionId,
        source: 'claude',
        cwd: info.cwd,
        repo,
        branch: info.gitBranch,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: fileStats.birthtime,
        updatedAt: fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
      });
    } catch (err) {
      logger.debug('claude: skipping unparseable session', filePath, err);
      // Skip files we can't parse
    }
  }

  return sessions.filter((s) => s.bytes > 200).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract session notes from thinking blocks and model info
 */
function extractSessionNotes(messages: ClaudeMessage[]): SessionNotes {
  const notes: SessionNotes = {};

  // Extract model from first message that has it
  for (const msg of messages) {
    if (msg.model && !notes.model) {
      notes.model = msg.model;
      break;
    }
  }

  // Extract thinking highlights via shared utility
  const anthropicMsgs: AnthropicMessage[] = messages
    .filter((m) => m.message?.content && Array.isArray(m.message.content))
    .map((m) => ({
      role: m.message!.role,
      content: m.message!.content as Array<{ type: string; [key: string]: unknown }>,
    }));

  const reasoning = extractThinkingHighlights(anthropicMsgs);
  if (reasoning.length > 0) notes.reasoning = reasoning;

  // Extract compact summary
  for (const msg of messages) {
    if (msg.isCompactSummary && msg.message?.content) {
      const text = extractTextFromBlocks(msg.message.content);
      if (text) {
        notes.compactSummary = truncate(text, 500);
        break;
      }
    }
  }

  return notes;
}

/**
 * Extract context from a Claude session for cross-tool continuation
 */
export async function extractClaudeContext(session: UnifiedSession): Promise<SessionContext> {
  const messages = await readJsonlFile<ClaudeMessage>(session.originalPath);
  const recentMessages: ConversationMessage[] = [];

  // Extract tool data via shared utility
  const anthropicMsgs: AnthropicMessage[] = messages
    .filter((m) => m.message?.content && Array.isArray(m.message.content))
    .map((m) => ({
      role: m.message!.role,
      content: m.message!.content as Array<{ type: string; [key: string]: unknown }>,
    }));

  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs);
  const sessionNotes = extractSessionNotes(messages);
  const pendingTasks: string[] = [];

  for (const msg of messages.slice(-20)) {
    if (msg.type === 'queue-operation' || msg.type === 'system') continue;
    if (msg.isCompactSummary) continue;

    if (msg.type === 'user') {
      const content = extractTextFromBlocks(msg.message?.content);
      if (content) {
        recentMessages.push({ role: 'user', content, timestamp: new Date(msg.timestamp) });
      }
    } else if (msg.type === 'assistant') {
      const content = extractTextFromBlocks(msg.message?.content);
      if (content) {
        recentMessages.push({ role: 'assistant', content, timestamp: new Date(msg.timestamp) });
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
    session,
    recentMessages: recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

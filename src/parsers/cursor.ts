import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionNotes, UnifiedSession } from '../types/index.js';
import type { CursorTranscriptLine } from '../types/schemas.js';
import { cleanUserQueryText, isRealUserMessage, isSystemContent } from '../utils/content.js';
import { findFiles } from '../utils/fs-helpers.js';
import { readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { cwdFromSlug } from '../utils/slug.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';

const CURSOR_PROJECTS_DIR = path.join(homeDir(), '.cursor', 'projects');

/**
 * Find all Cursor agent-transcript JSONL files.
 * Structure: ~/.cursor/projects/<project-slug>/agent-transcripts/<uuid>/<uuid>.jsonl
 */
async function findTranscriptFiles(): Promise<string[]> {
  if (!fs.existsSync(CURSOR_PROJECTS_DIR)) return [];

  const files: string[] = [];
  try {
    const projectDirs = fs.readdirSync(CURSOR_PROJECTS_DIR, { withFileTypes: true });
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, projectDir.name, 'agent-transcripts');
      const found = findFiles(transcriptsDir, {
        match: (entry, fullPath) => entry.name.endsWith('.jsonl') && fullPath.includes('agent-transcripts'),
        maxDepth: 2,
      });
      files.push(...found);
    }
  } catch (err) {
    logger.debug('cursor: cannot read base directory', CURSOR_PROJECTS_DIR, err);
    // Skip if base dir can't be read
  }
  return files;
}

/**
 * Extract the project slug from a transcript file path.
 */
function getProjectSlug(filePath: string): string {
  const parts = filePath.split(path.sep);
  const projectsIdx = parts.indexOf('projects');
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
    return parts[projectsIdx + 1];
  }
  return '';
}

function getSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

/**
 * Parse first few messages for summary
 */
async function parseSessionInfo(filePath: string): Promise<{
  firstUserMessage: string;
  lineCount: number;
}> {
  let firstUserMessage = '';
  let lineCount = 0;

  // Count all lines
  const lines = await readJsonlFile(filePath);
  lineCount = lines.length;

  // Scan head for first user message
  await scanJsonlHead(filePath, 50, (parsed) => {
    if (firstUserMessage) return 'continue';
    const line = parsed as CursorTranscriptLine;
    if (line.role === 'user') {
      for (const block of line.message?.content || []) {
        if (block.type === 'text' && block.text) {
          const cleaned = cleanUserQueryText(block.text);
          if (isRealUserMessage(cleaned)) {
            firstUserMessage = cleaned;
            return 'stop';
          }
        }
      }
    }
    return 'continue';
  });

  return { firstUserMessage, lineCount };
}

/**
 * Parse all Cursor sessions
 */
export async function parseCursorSessions(): Promise<UnifiedSession[]> {
  const files = await findTranscriptFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const { firstUserMessage, lineCount } = await parseSessionInfo(filePath);
      const fileStats = fs.statSync(filePath);
      const slug = getProjectSlug(filePath);
      const cwd = cwdFromSlug(slug);

      const summary = cleanSummary(firstUserMessage);

      sessions.push({
        id: getSessionId(filePath),
        source: 'cursor',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines: lineCount,
        bytes: fileStats.size,
        createdAt: fileStats.birthtime,
        updatedAt: fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
      });
    } catch (err) {
      logger.debug('cursor: skipping unparseable session', filePath, err);
      // Skip files we can't parse
    }
  }

  return sessions.filter((s) => s.bytes > 100).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Cursor session for cross-tool continuation
 */
export async function extractCursorContext(session: UnifiedSession): Promise<SessionContext> {
  const lines = await readJsonlFile<CursorTranscriptLine>(session.originalPath);
  const recentMessages: ConversationMessage[] = [];

  // Extract tool data via shared Anthropic utility
  const anthropicMsgs: AnthropicMessage[] = lines.map((l) => ({
    role: l.role,
    content: l.message.content,
  }));

  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs);

  // Extract session notes (thinking highlights)
  const sessionNotes: SessionNotes = {};
  const reasoning = extractThinkingHighlights(anthropicMsgs);
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  const pendingTasks: string[] = [];

  for (const line of lines) {
    const textParts: string[] = [];
    for (const block of line.message.content) {
      if (block.type === 'text' && block.text) {
        if (isSystemContent(block.text)) continue;
        const cleaned = line.role === 'user' ? cleanUserQueryText(block.text) : block.text;
        if (cleaned) textParts.push(cleaned);
      }
    }

    const text = textParts.join('\n').trim();
    if (!text) continue;

    recentMessages.push({
      role: line.role === 'user' ? 'user' : 'assistant',
      content: text,
    });
  }

  const trimmed = recentMessages.slice(-10);

  const markdown = generateHandoffMarkdown(session, trimmed, filesModified, pendingTasks, toolSummaries, sessionNotes);

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

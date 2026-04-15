import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionNotes, UnifiedSession } from '../types/index.js';
import type { CursorTranscriptLine } from '../types/schemas.js';
import { cleanUserQueryText, isRealUserMessage, isSystemContent } from '../utils/content.js';
import { findFiles } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
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
  bytes: number;
}> {
  let firstUserMessage = '';

  // Stream-count lines without full JSON parse (fast)
  const stats = await getFileStats(filePath);

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

  return { firstUserMessage, lineCount: stats.lines, bytes: stats.bytes };
}

/**
 * Parse all Cursor sessions
 */
export async function parseCursorSessions(): Promise<UnifiedSession[]> {
  const files = await findTranscriptFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const { firstUserMessage, lineCount, bytes } = await parseSessionInfo(filePath);
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
        bytes,
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
export async function extractCursorContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const lines = await readJsonlFile<CursorTranscriptLine>(session.originalPath);
  const recentMessages: ConversationMessage[] = [];

  // Extract tool data via shared Anthropic utility
  const anthropicMsgs: AnthropicMessage[] = lines.map((l) => ({
    role: l.role,
    content: l.message.content,
  }));

  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs, resolvedConfig);

  // Extract session notes (thinking highlights + token usage)
  const sessionNotes: SessionNotes = {};
  const reasoning = extractThinkingHighlights(anthropicMsgs);
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  if (!sessionNotes.reasoning) sessionNotes.reasoning = [];
  sessionNotes.reasoning.push(
    'Cursor transcript completeness warning: local agent-transcripts may omit tool outputs and can be less complete than hidden local stores or exported/session state.',
  );

  // Aggregate token usage, cache tokens, and model from passthrough fields.
  // Cursor CLI agent-transcripts use Anthropic API format — the schema's
  // .passthrough() preserves `usage` and `model` on each JSONL line.
  for (const line of lines) {
    if (line.role !== 'assistant') continue;
    const raw = line as Record<string, unknown>;

    // Model: take the first one found (all lines in a session use the same model)
    const model = (raw.model ?? (raw.message as Record<string, unknown> | undefined)?.model) as string | undefined;
    if (model && !sessionNotes.model) {
      sessionNotes.model = model;
    }

    // Usage may be at top level or nested under message (both observed in the wild)
    const usage = (raw.usage ?? (raw.message as Record<string, unknown> | undefined)?.usage) as
      | Record<string, number>
      | undefined;
    if (!usage) continue;

    if (!sessionNotes.tokenUsage) sessionNotes.tokenUsage = { input: 0, output: 0 };
    sessionNotes.tokenUsage.input += usage.input_tokens || 0;
    sessionNotes.tokenUsage.output += usage.output_tokens || 0;

    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    if (cacheCreation || cacheRead) {
      if (!sessionNotes.cacheTokens) sessionNotes.cacheTokens = { creation: 0, read: 0 };
      sessionNotes.cacheTokens.creation += cacheCreation;
      sessionNotes.cacheTokens.read += cacheRead;
    }
  }

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

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    resolvedConfig,
  );

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

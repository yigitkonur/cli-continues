import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionNotes, UnifiedSession } from '../types/index.js';
import type {
  DroidEvent,
  DroidMessageEvent,
  DroidSessionStart,
  DroidSettings,
  DroidTodoState,
} from '../types/schemas.js';
import { DroidSettingsSchema } from '../types/schemas.js';
import { isSystemContent } from '../utils/content.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { cwdFromSlug } from '../utils/slug.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';

const DROID_SESSIONS_DIR = path.join(homeDir(), '.factory', 'sessions');

/**
 * Find all Droid session JSONL files.
 * Structure: ~/.factory/sessions/<workspace-slug>/<uuid>.jsonl
 */
async function findSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const wsPath of listSubdirectories(DROID_SESSIONS_DIR)) {
    try {
      const entries = fs.readdirSync(wsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(path.join(wsPath, entry.name));
        }
      }
    } catch (err) {
      logger.debug('droid: cannot read session directory', wsPath, err);
      // Skip directories we can't read
    }
  }
  return files;
}

/**
 * Read companion .settings.json for a session
 */
function readSettings(jsonlPath: string): DroidSettings | null {
  const settingsPath = jsonlPath.replace(/\.jsonl$/, '.settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const result = DroidSettingsSchema.safeParse(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
      if (result.success) return result.data;
      logger.debug('droid: settings validation failed', settingsPath, result.error.message);
      return null;
    }
  } catch (err) {
    logger.debug('droid: failed to read settings', settingsPath, err);
  }
  return null;
}

/**
 * Parse session metadata from session_start event and first user message
 */
async function parseSessionInfo(filePath: string): Promise<{
  sessionStart: DroidSessionStart | null;
  firstUserMessage: string;
  firstTimestamp: string;
  lastTimestamp: string;
}> {
  let sessionStart: DroidSessionStart | null = null;
  let firstUserMessage = '';
  let firstTimestamp = '';
  let lastTimestamp = '';

  await scanJsonlHead(filePath, 100, (parsed) => {
    const event = parsed as DroidEvent;

    if (event.type === 'session_start' && !sessionStart) {
      sessionStart = event;
    }

    if (event.type === 'message') {
      if (event.timestamp) {
        if (!firstTimestamp) firstTimestamp = event.timestamp;
        lastTimestamp = event.timestamp;
      }

      if (!firstUserMessage && event.message.role === 'user') {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            if (!block.text.startsWith('<') && !block.text.startsWith('/') && !block.text.includes('Session Handoff')) {
              firstUserMessage = block.text;
              break;
            }
          }
        }
      }
    }

    return 'continue';
  });

  return { sessionStart, firstUserMessage, firstTimestamp, lastTimestamp };
}

/**
 * Parse all Droid sessions
 */
export async function parseDroidSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const { sessionStart, firstUserMessage, firstTimestamp, lastTimestamp } = await parseSessionInfo(filePath);
      if (!sessionStart) continue;

      const fileStats = fs.statSync(filePath);
      const stats = await getFileStats(filePath);
      const settings = readSettings(filePath);

      const workspaceSlug = path.basename(path.dirname(filePath));
      const cwd = sessionStart.cwd || cwdFromSlug(workspaceSlug);

      const summary = cleanSummary(firstUserMessage);

      const createdAt = firstTimestamp ? new Date(firstTimestamp) : fileStats.birthtime;
      const updatedAt = lastTimestamp ? new Date(lastTimestamp) : fileStats.mtime;

      sessions.push({
        id: sessionStart.id,
        source: 'droid',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines: stats.lines,
        bytes: fileStats.size,
        createdAt,
        updatedAt,
        originalPath: filePath,
        summary: summary || sessionStart.sessionTitle || undefined,
        model: settings?.model,
      });
    } catch (err) {
      logger.debug('droid: skipping unparseable session', filePath, err);
      // Skip files we can't parse
    }
  }

  return sessions.filter((s) => s.lines > 1).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract session notes: model info, token usage, reasoning/thinking highlights
 */
function extractSessionNotes(events: DroidEvent[], settings: DroidSettings | null): SessionNotes {
  const notes: SessionNotes = {};

  if (settings?.model) notes.model = settings.model;
  if (settings?.tokenUsage) {
    notes.tokenUsage = {
      input: settings.tokenUsage.inputTokens || 0,
      output: settings.tokenUsage.outputTokens || 0,
    };
  }

  // Extract thinking highlights via shared utility
  const anthropicMsgs: AnthropicMessage[] = events
    .filter((e): e is DroidMessageEvent => e.type === 'message' && e.message.role === 'assistant')
    .map((e) => ({ role: e.message.role, content: e.message.content }));

  const reasoning = extractThinkingHighlights(anthropicMsgs);
  if (reasoning.length > 0) notes.reasoning = reasoning;

  return notes;
}

/**
 * Extract pending tasks from the most recent todo_state event
 */
function extractPendingTasks(events: DroidEvent[]): string[] {
  const tasks: string[] = [];

  let lastTodo: DroidTodoState | null = null;
  for (const event of events) {
    if (event.type === 'todo_state') {
      lastTodo = event;
    }
  }

  if (!lastTodo) return tasks;

  const todosText = typeof lastTodo.todos === 'string' ? lastTodo.todos : lastTodo.todos?.todos || '';
  if (!todosText) return tasks;

  for (const line of todosText.split('\n')) {
    const match = line.match(/^\d+\.\s*\[(in_progress|pending)\]\s+(.+)/);
    if (match && tasks.length < 5) {
      tasks.push(match[2].trim());
    }
  }

  return tasks;
}

/**
 * Extract context from a Droid session for cross-tool continuation
 */
export async function extractDroidContext(session: UnifiedSession): Promise<SessionContext> {
  const events = await readJsonlFile<DroidEvent>(session.originalPath);
  const settings = readSettings(session.originalPath);

  // Extract tool data via shared Anthropic utility
  const anthropicMsgs: AnthropicMessage[] = events
    .filter((e): e is DroidMessageEvent => e.type === 'message')
    .map((e) => ({ role: e.message.role, content: e.message.content }));

  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs);
  const sessionNotes = extractSessionNotes(events, settings);
  const pendingTasks = extractPendingTasks(events);

  // Collect conversation messages (text content only)
  const recentMessages: ConversationMessage[] = [];

  for (const event of events) {
    if (event.type !== 'message') continue;

    const textParts: string[] = [];
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        if (!isSystemContent(block.text)) {
          textParts.push(block.text);
        }
      }
    }

    const text = textParts.join('\n').trim();
    if (!text) continue;

    recentMessages.push({
      role: event.message.role === 'user' ? 'user' : 'assistant',
      content: text,
      timestamp: event.timestamp ? new Date(event.timestamp) : undefined,
    });
  }

  const trimmed = recentMessages.slice(-10);

  const markdown = generateHandoffMarkdown(session, trimmed, filesModified, pendingTasks, toolSummaries, sessionNotes);

  return {
    session: sessionNotes?.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

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
import type {
  DroidCompactionState,
  DroidEvent,
  DroidMessageEvent,
  DroidSessionStart,
  DroidSettings,
  DroidTodoState,
} from '../types/schemas.js';
import { DroidSettingsSchema } from '../types/schemas.js';
import { isSystemContent } from '../utils/content.js';
import { findFiles } from '../utils/fs-helpers.js';
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

const DROID_PROJECTS_DIR = path.join(homeDir(), '.factory', 'projects');
const DROID_SESSIONS_DIR = path.join(homeDir(), '.factory', 'sessions');
const DROID_SESSION_DIRS = [DROID_PROJECTS_DIR, DROID_SESSIONS_DIR];

/**
 * Find all Droid session JSONL files.
 * Structures:
 * - ~/.factory/projects/<workspace-slug>/<uuid>.jsonl
 * - ~/.factory/sessions/<workspace-slug>/<uuid>.jsonl
 */
async function findSessionFiles(): Promise<string[]> {
  const files = new Set<string>();
  for (const root of DROID_SESSION_DIRS) {
    for (const filePath of findFiles(root, {
      match: (entry) =>
        entry.name.endsWith('.jsonl') &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(entry.name),
      maxDepth: 3,
    })) {
      files.add(filePath);
    }
  }
  return Array.from(files);
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
async function parseSessionInfo(
  filePath: string,
  options: SessionParseOptions = {},
): Promise<{
  sessionStart: DroidSessionStart | null;
  firstUserMessage: string;
  firstTimestamp: string;
  lastTimestamp: string;
  cwdIsNotGitRepo: boolean;
}> {
  let sessionStart: DroidSessionStart | null = null;
  let firstUserMessage = '';
  let firstTimestamp = '';
  let lastTimestamp = '';
  let cwdIsNotGitRepo = false;

  const visitor = (parsed: unknown): 'continue' | 'stop' => {
    const event = parsed as DroidEvent;

    if (event.type === 'session_start' && !sessionStart) {
      sessionStart = event;
    }

    if ('timestamp' in event && typeof event.timestamp === 'string') {
      if (!firstTimestamp) firstTimestamp = event.timestamp;
      lastTimestamp = event.timestamp;
    }

    if (event.type === 'message') {
      if (!firstUserMessage && event.message.role === 'user') {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            const cleaned = stripDroidInjectedText(block.text);
            if (block.text.includes('<system-reminder>') && block.text.includes('fatal: not a git repository')) {
              cwdIsNotGitRepo = true;
            }
            if (cleaned && !cleaned.startsWith('<') && !cleaned.startsWith('/') && !cleaned.includes('Session Handoff')) {
              firstUserMessage = cleaned;
              break;
            }
          }
        }
      }
    }

    return 'continue';
  };

  if (options.lightweight) {
    await scanJsonlHead(filePath, 100, visitor);
  } else {
    await scanJsonlFile(filePath, visitor);
  }

  return { sessionStart, firstUserMessage, firstTimestamp, lastTimestamp, cwdIsNotGitRepo };
}

/**
 * Parse all Droid sessions
 */
export async function parseDroidSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessionsById = new Map<string, UnifiedSession>();
  const lightweight = options.lightweight === true;

  for (const filePath of files) {
    try {
      const { sessionStart, firstUserMessage, firstTimestamp, lastTimestamp, cwdIsNotGitRepo } = await parseSessionInfo(
        filePath,
        options,
      );
      if (!sessionStart) continue;

      const fileStats = fs.statSync(filePath);
      const stats = lightweight ? { lines: 0, bytes: fileStats.size } : await getFileStats(filePath);
      const settings = readSettings(filePath);

      const workspaceSlug = path.basename(path.dirname(filePath));
      const cwd = sessionStart.cwd || cwdFromSlug(workspaceSlug);

      const summary = cleanSummary(firstUserMessage);

      const createdAt = firstTimestamp ? new Date(firstTimestamp) : fileStats.birthtime;
      const updatedAt = lastTimestamp ? new Date(lastTimestamp) : fileStats.mtime;

      const nextSession: UnifiedSession = {
        id: sessionStart.id,
        source: 'droid',
        cwd,
        repo: cwdIsNotGitRepo ? undefined : extractRepoFromCwd(cwd),
        lines: stats.lines,
        bytes: fileStats.size,
        createdAt,
        updatedAt,
        originalPath: filePath,
        summary: summary || sessionStart.sessionTitle || undefined,
        model: settings?.model,
      };

      const existing = sessionsById.get(nextSession.id);
      const existingTime = existing?.updatedAt.getTime() ?? 0;
      const nextTime = nextSession.updatedAt.getTime();
      const nextIsProjectTranscript = nextSession.originalPath.startsWith(DROID_PROJECTS_DIR);
      if (!existing || existingTime < nextTime || (existingTime === nextTime && nextIsProjectTranscript)) {
        sessionsById.set(nextSession.id, nextSession);
      }
    } catch (err) {
      logger.debug('droid: skipping unparseable session', filePath, err);
      // Skip files we can't parse
    }
  }

  return Array.from(sessionsById.values())
    .filter((s) => lightweight || s.lines > 1)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
    const cacheCreation = settings.tokenUsage.cacheCreationTokens || 0;
    const cacheRead = settings.tokenUsage.cacheReadTokens || 0;
    if (cacheCreation || cacheRead) {
      notes.cacheTokens = { creation: cacheCreation, read: cacheRead };
    }
    if (settings.tokenUsage.thinkingTokens) {
      notes.thinkingTokens = settings.tokenUsage.thinkingTokens;
    }
  }
  if (settings?.assistantActiveTimeMs) {
    notes.activeTimeMs = settings.assistantActiveTimeMs;
  }

  for (const event of events) {
    if (event.type === 'session_start') {
      notes.sourceMetadata = {
        ...(notes.sourceMetadata ?? {}),
        sessionTitle: event.sessionTitle,
        owner: event.owner,
        version: event.version,
        cwd: event.cwd,
      };
      continue;
    }
    if (event.type !== 'message') continue;
    for (const block of event.message.content) {
      if (block.type !== 'text' || !block.text) continue;
      if (
        block.text.includes('<system-reminder>') ||
        (block.text.includes('git rev-parse') && block.text.includes('fatal: not a git repository'))
      ) {
        if (!notes.bootstrap) notes.bootstrap = [];
        notes.bootstrap.push({
          type: 'bootstrap',
          content: block.text,
          ...(event.timestamp ? { timestamp: event.timestamp } : {}),
          metadata: { messageId: event.id, parentId: event.parentId },
        });
      }
    }
  }

  // Extract compaction summary — take the LAST one (most comprehensive)
  for (const event of events) {
    if (event.type === 'compaction_state') {
      const cs = event as DroidCompactionState;
      if (cs.summaryText) {
        notes.compactSummary = truncate(cs.summaryText, 500);
      }
    }
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
export async function extractDroidContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const events = await readJsonlFile<DroidEvent>(session.originalPath);
  const settings = readSettings(session.originalPath);

  // Extract tool data via shared Anthropic utility
  const anthropicMsgs: AnthropicMessage[] = events
    .filter((e): e is DroidMessageEvent => e.type === 'message')
    .map((e) => ({ role: e.message.role, content: e.message.content }));

  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs, resolvedConfig);
  const sessionNotes = extractSessionNotes(events, settings);
  const pendingTasks = extractPendingTasks(events);

  // Collect conversation messages (text content only)
  const recentMessages: ConversationMessage[] = [];
  const timeline: SessionEvent[] = [];
  let sequence = 0;

  for (const event of events) {
    if (event.type !== 'message') continue;

    const textParts: string[] = [];
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        const cleaned = stripDroidInjectedText(block.text);
        if (cleaned && !isSystemContent(cleaned)) {
          textParts.push(cleaned);
        }
      }
    }

    const text = textParts.join('\n').trim();
    if (!text) continue;

    recentMessages.push({
      role: event.message.role === 'user' ? 'user' : 'assistant',
      content: text,
      timestamp: event.timestamp ? new Date(event.timestamp) : undefined,
      sourceId: event.id,
      sourceParentId: event.parentId,
    });
    timeline.push({
      kind: 'message',
      sequence: sequence++,
      role: event.message.role === 'user' ? 'user' : 'assistant',
      content: text,
      timestamp: event.timestamp ? new Date(event.timestamp) : undefined,
      sourceId: event.id,
      sourceParentId: event.parentId,
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

function stripDroidInjectedText(text: string): string {
  const hadSystemReminder = text.includes('<system-reminder>');
  let result = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/giu, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/giu, '');
  if (hadSystemReminder) {
    // Strip TodoWrite tool-list dump only when it appears as a contiguous run of
    // CapitalizedToolName lines starting at a line boundary. Earlier `[\s\S]*$`
    // version was too greedy: `\nTodoWrite\nListTodos\n<user prose>` deleted the
    // user prose along with the tool list. The bounded form stops at the first
    // non-capitalized line, preserving any trailing user content.
    result = result.replace(/^[ \t]*TodoWrite\b(?:\r?\n[ \t]*[A-Z][A-Za-z0-9]+\b)*[ \t]*\r?$/m, '');
  }
  return result.trim();
}

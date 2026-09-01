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
  SessionSource,
  UnifiedSession,
} from '../types/index.js';
import { isSystemContent } from '../utils/content.js';
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';
import { truncate } from '../utils/tool-summarizer.js';

type PiFamilySource = Extract<SessionSource, 'pi' | 'omp'>;

/** Files up to this size get exact line counts even in lightweight discovery. */
const SMALL_FILE_EXACT_COUNT_BYTES = 8 * 1024;

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiMessage {
  role?: string;
  content?: string | PiContentBlock[];
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  version?: number;
  name?: string;
  provider?: string;
  model?: string;
  modelId?: string;
  summary?: string;
  message?: PiMessage;
}

interface PiFamilyDefinition {
  source: PiFamilySource;
  defaultAgentDir: string;
}

function sessionDir(definition: PiFamilyDefinition): string {
  if (definition.source === 'pi') {
    if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
    return path.join(process.env.PI_CODING_AGENT_DIR || definition.defaultAgentDir, 'sessions');
  }
  return path.join(definition.defaultAgentDir, 'sessions');
}

function sessionFiles(definition: PiFamilyDefinition): string[] {
  return findFiles(sessionDir(definition), {
    match: (entry) => entry.name.endsWith('.jsonl'),
    maxDepth: 1,
  });
}

function textFromContent(content: PiMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

async function scanMetadata(
  filePath: string,
  lightweight: boolean,
): Promise<{
  header?: PiEntry;
  firstUserMessage: string;
  sessionName?: string;
  model?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
}> {
  let header: PiEntry | undefined;
  let firstUserMessage = '';
  let sessionName: string | undefined;
  let model: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  const visitor = (value: unknown): 'continue' => {
    const entry = value as PiEntry;
    if (entry.type === 'session' && !header && entry.id && entry.cwd) header = entry;
    if (entry.timestamp) {
      firstTimestamp ||= entry.timestamp;
      lastTimestamp = entry.timestamp;
    }
    if (entry.type === 'session_info' && entry.name) sessionName = entry.name;
    if (entry.type === 'model_change') model = entry.modelId || entry.model || model;
    if (entry.type === 'message') {
      if (entry.message?.model) model = entry.message.model;
      if (!firstUserMessage && entry.message?.role === 'user') {
        firstUserMessage = textFromContent(entry.message.content);
      }
    }
    return 'continue';
  };

  if (lightweight) {
    await scanJsonlHead(filePath, 100, (parsed) => {
      visitor(parsed);
      return firstUserMessage && header ? 'stop' : 'continue';
    });
  } else await scanJsonlFile(filePath, visitor);
  return { header, firstUserMessage, sessionName, model, firstTimestamp, lastTimestamp };
}

export function createPiFamilyParser(definition: PiFamilyDefinition): {
  parseSessions: (options?: SessionParseOptions) => Promise<UnifiedSession[]>;
  extractContext: (session: UnifiedSession, config?: VerbosityConfig) => Promise<SessionContext>;
} {
  const parseSessions = async (options: SessionParseOptions = {}): Promise<UnifiedSession[]> => {
    const lightweight = options.lightweight === true;

    const parsed = await mapConcurrent(
      sessionFiles(definition),
      16,
      async (filePath): Promise<UnifiedSession | null> => {
        try {
          const metadata = await scanMetadata(filePath, lightweight);
          if (!metadata.header?.id || !metadata.header.cwd) return null;
          if (options.cwd && path.resolve(metadata.header.cwd) !== path.resolve(options.cwd)) return null;

          const stat = fs.statSync(filePath);
          // Exact line counts only for small files: large transcripts skip
          // counting in lightweight discovery, while tiny session stubs stay
          // cheap to measure and filter as empty.
          const stats =
            lightweight && stat.size > SMALL_FILE_EXACT_COUNT_BYTES
              ? { lines: 0, bytes: stat.size }
              : await getFileStats(filePath);
          return {
            id: metadata.header.id,
            source: definition.source,
            cwd: metadata.header.cwd,
            repo: extractRepoFromCwd(metadata.header.cwd),
            summary: metadata.sessionName || cleanSummary(metadata.firstUserMessage) || undefined,
            lines: stats.lines,
            bytes: stat.size,
            createdAt: metadata.firstTimestamp ? new Date(metadata.firstTimestamp) : stat.birthtime,
            // Lightweight discovery stops at the first user message, so file
            // mtime is the accurate "last active" signal for ordering.
            updatedAt: lightweight
              ? stat.mtime
              : metadata.lastTimestamp
                ? new Date(metadata.lastTimestamp)
                : stat.mtime,
            originalPath: filePath,
            model: metadata.model,
          };
        } catch (err) {
          logger.debug(`${definition.source}: skipping unparseable session`, filePath, err);
          return null;
        }
      },
    );

    return parsed
      .filter((session): session is UnifiedSession => session !== null)
      .filter((session) => session.lines === 0 || session.lines > 1)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  };

  const extractContext = async (session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> => {
    const resolvedConfig = config ?? getPreset('standard');
    const allEntries = await readJsonlFile<PiEntry>(session.originalPath);
    const entries = activeBranch(allEntries);
    const anthropicMessages = toAnthropicMessages(entries);
    const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMessages, resolvedConfig);
    const sessionNotes = extractNotes(entries, session.originalPath);
    const recentMessages: ConversationMessage[] = [];
    const timeline: SessionEvent[] = [];
    let sequence = 0;

    for (const entry of entries) {
      if (entry.type !== 'message' || !entry.message) continue;
      if (entry.message.role !== 'user' && entry.message.role !== 'assistant') continue;
      const text = textFromContent(entry.message.content);
      if (!text || isSystemContent(text)) continue;
      const message: ConversationMessage = {
        role: entry.message.role,
        content: text,
        timestamp: entry.timestamp ? new Date(entry.timestamp) : undefined,
        sourceId: entry.id,
        sourceParentId: entry.parentId ?? undefined,
      };
      recentMessages.push(message);
      timeline.push({ kind: 'message', sequence: sequence++, ...message });
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
  };

  return { parseSessions, extractContext };
}

function activeBranch(entries: PiEntry[]): PiEntry[] {
  const treeEntries = entries.filter((entry) => entry.type !== 'session' && entry.id);
  if (!treeEntries.some((entry) => entry.parentId !== undefined)) return treeEntries;

  const byId = new Map(treeEntries.map((entry) => [entry.id as string, entry]));
  const branch: PiEntry[] = [];
  let current: PiEntry | undefined = treeEntries.at(-1);
  const visited = new Set<string>();
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

function toAnthropicMessages(entries: PiEntry[]): AnthropicMessage[] {
  return entries
    .filter((entry) => entry.type === 'message' && entry.message)
    .map((entry) => {
      const message = entry.message as PiMessage;
      if (message.role === 'toolResult') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId || '',
              content: textFromContent(message.content),
              is_error: message.isError,
            },
          ],
        } as AnthropicMessage;
      }
      const content = Array.isArray(message.content)
        ? message.content.map((block) =>
            block.type === 'toolCall'
              ? { type: 'tool_use', id: block.id || '', name: block.name || '', input: block.arguments || {} }
              : block,
          )
        : message.content;
      return { role: message.role || 'user', content } as AnthropicMessage;
    });
}

function extractNotes(entries: PiEntry[], originalPath: string): SessionNotes {
  const notes: SessionNotes = {
    rawAccess: { kind: 'file', path: originalPath },
  };
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  for (const entry of entries) {
    if (entry.type === 'model_change') notes.model = entry.modelId || entry.model || notes.model;
    if (entry.type === 'compaction' && entry.summary) notes.compactSummary = truncate(entry.summary, 500);
    if (entry.type !== 'message' || !entry.message) continue;
    if (entry.message.model) notes.model = entry.message.model;
    input += entry.message.usage?.input || 0;
    output += entry.message.usage?.output || 0;
    cacheRead += entry.message.usage?.cacheRead || 0;
    cacheWrite += entry.message.usage?.cacheWrite || 0;
  }
  if (input || output) notes.tokenUsage = { input, output };
  if (cacheRead || cacheWrite) notes.cacheTokens = { read: cacheRead, creation: cacheWrite };

  const reasoning = extractThinkingHighlights(toAnthropicMessages(entries));
  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

function defaultParser(source: PiFamilySource) {
  return createPiFamilyParser({
    source,
    defaultAgentDir: path.join(homeDir(), source === 'pi' ? '.pi' : '.omp', 'agent'),
  });
}

export function parsePiSessions(options?: SessionParseOptions): Promise<UnifiedSession[]> {
  return defaultParser('pi').parseSessions(options);
}

export function extractPiContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  return defaultParser('pi').extractContext(session, config);
}

export function parseOmpSessions(options?: SessionParseOptions): Promise<UnifiedSession[]> {
  return defaultParser('omp').parseSessions(options);
}

export function extractOmpContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  return defaultParser('omp').extractContext(session, config);
}

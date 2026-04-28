import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionEvent,
  SessionNotes,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import { extractTextFromBlocks } from '../utils/content.js';
import { findFiles } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepo, homeDir } from '../utils/parser-helpers.js';
import { truncate } from '../utils/tool-summarizer.js';

// ── Amp Thread JSON shape ───────────────────────────────────────────────────
// Minimal interfaces matching ~/.local/share/amp/threads/{id}.json

interface AmpContentBlock {
  type: string;
  text?: string;
  provider?: string;
}

interface AmpMessage {
  role: 'user' | 'assistant';
  messageId: number;
  content: AmpContentBlock[];
  meta?: {
    sentAt?: number;
  };
}

interface AmpUsageEvent {
  model?: string;
  credits?: number;
  tokens?: { input?: number; output?: number };
  operationType?: string;
  fromMessageId?: number;
  toMessageId?: number;
}

interface AmpThread {
  id: string;
  title?: string;
  created: number; // milliseconds since epoch
  messages: AmpMessage[];
  usageLedger?: {
    events?: AmpUsageEvent[];
  };
  env?: {
    initial?: {
      tags?: string[];
      trees?: Array<{
        uri?: string;
        repository?: {
          url?: string;
          ref?: string;
          sha?: string;
        };
      }>;
    };
  };
}

const AMP_BASE_DIR = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'amp', 'threads')
  : path.join(homeDir(), '.local', 'share', 'amp', 'threads');

function safeFileURLToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return '';
  }
}

/**
 * Find all Amp thread JSON files
 */
function findSessionFiles(): string[] {
  return findFiles(AMP_BASE_DIR, {
    match: (entry) => entry.name.endsWith('.json'),
    recursive: false,
  });
}

/**
 * Read and parse a thread file in a single pass — returns the parsed thread plus
 * the raw text so callers can derive line counts without re-reading the file.
 */
function readThreadFile(filePath: string): { thread: AmpThread; raw: string } | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (typeof data.id !== 'string' || typeof data.created !== 'number' || !Array.isArray(data.messages)) {
      logger.debug('amp: thread validation failed — missing id, created, or messages', filePath);
      return null;
    }
    return { thread: data as AmpThread, raw };
  } catch (err) {
    logger.debug('amp: failed to parse thread file', filePath, err);
    return null;
  }
}

function parseThreadFile(filePath: string): AmpThread | null {
  return readThreadFile(filePath)?.thread ?? null;
}

function extractMessageText(message: AmpMessage): string {
  return extractTextFromBlocks(message.content).trim();
}

/**
 * Extract the first real user message for use as a session summary
 */
function extractFirstUserMessage(thread: AmpThread): string {
  for (const msg of thread.messages) {
    if (msg.role === 'user') {
      const text = extractMessageText(msg);
      if (text) return text;
    }
  }
  return '';
}

/**
 * Extract model identifier from env.initial.tags (e.g. "model:claude-opus-4-5-20251101" → "claude-opus-4-5-20251101")
 */
function extractModel(thread: AmpThread): string | undefined {
  const tags = thread.env?.initial?.tags;
  if (!Array.isArray(tags)) return undefined;

  for (const tag of tags) {
    if (typeof tag === 'string' && tag.startsWith('model:')) {
      return tag.slice('model:'.length);
    }
  }
  return undefined;
}

function extractAmpMetadata(thread: AmpThread): Pick<UnifiedSession, 'cwd' | 'repo' | 'branch' | 'gitSha'> {
  const firstTree = thread.env?.initial?.trees?.[0];
  const cwd = firstTree?.uri?.startsWith('file://') ? safeFileURLToPath(firstTree.uri) : '';
  const repo = extractRepo({ gitUrl: firstTree?.repository?.url, cwd });
  const ref = firstTree?.repository?.ref;
  const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;

  return {
    cwd,
    ...(repo ? { repo } : {}),
    ...(branch ? { branch } : {}),
    ...(firstTree?.repository?.sha ? { gitSha: firstTree.repository.sha } : {}),
  };
}

/**
 * Extract session notes: model info and token usage from usageLedger
 */
function extractSessionNotes(
  thread: AmpThread,
  metadata: Pick<UnifiedSession, 'cwd' | 'repo' | 'branch' | 'gitSha'> = extractAmpMetadata(thread),
): SessionNotes {
  const notes: SessionNotes = {};

  const model = extractModel(thread);
  if (model) notes.model = model;
  notes.sourceMetadata = {
    ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
    ...(metadata.repo ? { repo: metadata.repo } : {}),
    ...(metadata.branch ? { branch: metadata.branch } : {}),
    ...(metadata.gitSha ? { gitSha: metadata.gitSha } : {}),
  };

  // Accumulate token usage from ledger events, skipping title-generation
  const events = thread.usageLedger?.events;
  if (Array.isArray(events)) {
    let inputTokens = 0;
    let outputTokens = 0;

    for (const event of events) {
      if (event.operationType === 'title-generation') continue;

      if (event.tokens) {
        inputTokens += event.tokens.input ?? 0;
        outputTokens += event.tokens.output ?? 0;
      }

      // Use the first non-title-generation model as fallback if env tags didn't provide one
      if (!notes.model && event.model) {
        notes.model = event.model;
      }
    }

    if (inputTokens > 0 || outputTokens > 0) {
      notes.tokenUsage = { input: inputTokens, output: outputTokens };
    }
  }

  return notes;
}

/**
 * Parse all Amp sessions
 */
export async function parseAmpSessions(): Promise<UnifiedSession[]> {
  const files = findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const parsed = readThreadFile(filePath);
      if (!parsed || !parsed.thread.id) continue;
      const { thread, raw } = parsed;

      const firstUserMessage = extractFirstUserMessage(thread);
      const summary = cleanSummary(thread.title || firstUserMessage);
      const metadata = extractAmpMetadata(thread);
      const fileStats = fs.statSync(filePath);

      sessions.push({
        id: thread.id,
        source: 'amp',
        cwd: metadata.cwd || '',
        repo: metadata.repo,
        branch: metadata.branch,
        gitSha: metadata.gitSha,
        lines: raw.split('\n').length,
        bytes: fileStats.size,
        createdAt: new Date(thread.created),
        updatedAt: new Date(fileStats.mtimeMs),
        originalPath: filePath,
        summary: summary || undefined,
        model: extractModel(thread),
      });
    } catch (err) {
      logger.debug('amp: skipping unparseable thread', filePath, err);
    }
  }

  return sessions
    .filter((s) => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from an Amp session for cross-tool continuation
 */
export async function extractAmpContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const cfg = config ?? getPreset('standard');
  const thread = parseThreadFile(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];
  const toolSummaries: ToolUsageSummary[] = [];
  let sessionNotes: SessionNotes | undefined;

  if (thread) {
    // Compute metadata once and reuse for both sessionNotes and the enrichedSession.
    const metadata = extractAmpMetadata(thread);
    sessionNotes = extractSessionNotes(thread, metadata);
    const enrichedSession: UnifiedSession = {
      ...session,
      cwd: session.cwd || metadata.cwd || '',
      repo: session.repo || metadata.repo,
      branch: session.branch || metadata.branch,
      gitSha: session.gitSha || metadata.gitSha,
      model: session.model || sessionNotes.model,
    };
    const timeline: SessionEvent[] = [];
    let sequence = 0;

    // Convert Amp messages to unified ConversationMessage format.
    // Slice to recent window (×2 to account for user+assistant pairs, matching gemini pattern).
    for (const msg of thread.messages.slice(-cfg.recentMessages * 2)) {
      const text = extractMessageText(msg);
      if (!text) continue;

      if (msg.role === 'user' || msg.role === 'assistant') {
        recentMessages.push({
          role: msg.role,
          content: text,
          timestamp: new Date(msg.meta?.sentAt ?? thread.created),
          sourceId: String(msg.messageId),
        });
        timeline.push({
          kind: 'message',
          sequence: sequence++,
          role: msg.role,
          content: text,
          timestamp: new Date(msg.meta?.sentAt ?? thread.created),
          sourceId: String(msg.messageId),
        });
      }
    }

    // Scan last few assistant messages for pending-task signals
    const assistantMessages = thread.messages.filter((m) => m.role === 'assistant');
    for (const msg of assistantMessages.slice(-3)) {
      if (pendingTasks.length >= 5) break;
      const text = extractMessageText(msg).toLowerCase();
      if (
        text.includes('todo') ||
        text.includes('next step') ||
        text.includes('remaining') ||
        text.includes('need to')
      ) {
        // Extract the first sentence containing the keyword as the task hint
        const sentences = extractMessageText(msg)
          .split(/[.!\n]/)
          .filter(Boolean);
        for (const sentence of sentences) {
          if (pendingTasks.length >= 5) break;
          const lower = sentence.toLowerCase();
          if (
            lower.includes('todo') ||
            lower.includes('next step') ||
            lower.includes('remaining') ||
            lower.includes('need to')
          ) {
            pendingTasks.push(truncate(sentence.trim(), 120));
          }
        }
      }
    }
    const trimmed = recentMessages.slice(-cfg.recentMessages);

    const markdown = generateHandoffMarkdown(
      enrichedSession,
      trimmed,
      filesModified,
      pendingTasks,
      toolSummaries,
      sessionNotes,
      cfg,
      'inline',
      timeline,
    );

    return {
      session: enrichedSession,
      recentMessages: trimmed,
      filesModified,
      pendingTasks,
      toolSummaries,
      sessionNotes,
      timeline,
      markdown,
    };
  }

  const trimmed = recentMessages.slice(-cfg.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    cfg,
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

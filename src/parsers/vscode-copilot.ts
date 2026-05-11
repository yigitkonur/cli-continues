import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionParseOptions, UnifiedSession } from '../types/index.js';
import { findFiles } from '../utils/fs-helpers.js';
import { scanJsonlFile } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { homeDir, trimMessages } from '../utils/parser-helpers.js';

function getWorkspaceStorageDir(): string {
  if (process.env.VSCODE_COPILOT_HOME) return process.env.VSCODE_COPILOT_HOME;
  const home = homeDir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'workspaceStorage');
  }
  if (process.platform === 'linux') {
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Code', 'User', 'workspaceStorage');
  }
  return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
}

const WORKSPACE_STORAGE_DIR = getWorkspaceStorageDir();

interface VscodeChatResponsePart {
  value?: string;
  kind?: string;
}

interface VscodeChatRequest {
  requestId?: string;
  message?: { text?: string };
  response?: VscodeChatResponsePart[];
  result?: { details?: string };
  timestamp?: number;
}

// ── JSON format (legacy) ──────────────────────────────────────────────────────

interface VscodeChatSessionJson {
  sessionId?: string;
  creationDate?: number;
  lastMessageDate?: number;
  customTitle?: string;
  requests?: VscodeChatRequest[];
}

// ── JSONL format (current) ────────────────────────────────────────────────────
// Append log: each line is {kind, v}
// kind=0 → session metadata
// kind=1 → state patch: string=title update, otherwise ignored
// kind=2 → list of request-response turns (items with requestId) or response chunks

interface VscodeChatSessionMeta {
  sessionId?: string;
  creationDate?: number;
  lastMessageDate?: number;
}

interface VscodeChatTurn {
  requestId: string;
  timestamp?: number;
  message?: { text?: string };
  response?: VscodeChatResponsePart[];
  result?: { details?: string };
}

interface ParsedJsonlSession {
  meta: VscodeChatSessionMeta;
  title: string;
  turns: VscodeChatTurn[];
  lastTimestamp: number;
}

async function parseJsonlSession(filePath: string): Promise<ParsedJsonlSession | null> {
  const meta: VscodeChatSessionMeta = {};
  let title = '';
  const turns: VscodeChatTurn[] = [];
  let lastTimestamp = 0;

  await scanJsonlFile(filePath, (parsed) => {
    const entry = parsed as { kind: number; v: unknown };
    if (entry.kind === 0 && entry.v && typeof entry.v === 'object' && !Array.isArray(entry.v)) {
      const v = entry.v as VscodeChatSessionMeta;
      if (v.sessionId) meta.sessionId = v.sessionId;
      if (v.creationDate) meta.creationDate = v.creationDate;
      if (v.lastMessageDate) meta.lastMessageDate = v.lastMessageDate;
    } else if (entry.kind === 1 && typeof entry.v === 'string' && entry.v.trim()) {
      const k = (entry as unknown as { k?: unknown }).k;
      if (Array.isArray(k) && k.length === 1 && k[0] === 'customTitle') {
        title = entry.v.trim();
      }
    } else if (entry.kind === 2 && Array.isArray(entry.v)) {
      for (const item of entry.v as unknown[]) {
        if (!item || typeof item !== 'object' || !('requestId' in item)) continue;
        const turn = item as VscodeChatTurn;
        turns.push(turn);
        if (turn.timestamp && turn.timestamp > lastTimestamp) lastTimestamp = turn.timestamp;
      }
    }
    return 'continue';
  });

  if (!meta.sessionId && turns.length === 0) return null;
  return { meta, title, turns, lastTimestamp };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function extractResponseText(parts: VscodeChatResponsePart[]): string {
  return parts
    .filter((p) => p.kind !== 'inlineReference' && typeof p.value === 'string')
    .map((p) => p.value as string)
    .join('');
}

function extractModelFromRequests(requests: VscodeChatRequest[]): string | undefined {
  for (const req of requests) {
    const details = req.result?.details;
    if (details) {
      const model = details.split('•')[0].trim();
      if (model) return model;
    }
  }
  return undefined;
}

function extractModelFromTurns(turns: VscodeChatTurn[]): string | undefined {
  for (const turn of turns) {
    const details = turn.result?.details;
    if (details) {
      const model = details.split('•')[0].trim();
      if (model) return model;
    }
  }
  return undefined;
}

function extractCwd(workspaceJson: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(workspaceJson, 'utf-8')) as { folder?: string; workspace?: string };
    const raw = data.folder ?? data.workspace ?? '';
    return raw.replace(/^file:\/\//, '');
  } catch {
    return '';
  }
}

function messagesFromRequests(requests: VscodeChatRequest[]): ConversationMessage[] {
  const msgs: ConversationMessage[] = [];
  for (const req of requests) {
    const userText = req.message?.text?.trim() ?? '';
    if (userText) msgs.push({ role: 'user', content: userText, timestamp: req.timestamp ? new Date(req.timestamp) : undefined });
    const assistantText = extractResponseText(req.response ?? []).trim();
    if (assistantText) msgs.push({ role: 'assistant', content: assistantText, timestamp: req.timestamp ? new Date(req.timestamp) : undefined });
  }
  return msgs;
}

function messagesFromTurns(turns: VscodeChatTurn[]): ConversationMessage[] {
  const msgs: ConversationMessage[] = [];
  for (const turn of turns) {
    const userText = turn.message?.text?.trim() ?? '';
    if (userText) msgs.push({ role: 'user', content: userText, timestamp: turn.timestamp ? new Date(turn.timestamp) : undefined });
    const assistantText = extractResponseText(turn.response ?? []).trim();
    if (assistantText) msgs.push({ role: 'assistant', content: assistantText, timestamp: turn.timestamp ? new Date(turn.timestamp) : undefined });
  }
  return msgs;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

async function findChatSessionFiles(): Promise<Array<{ filePath: string; hashDir: string }>> {
  if (!fs.existsSync(WORKSPACE_STORAGE_DIR)) return [];
  const results: Array<{ filePath: string; hashDir: string }> = [];
  const files = findFiles(WORKSPACE_STORAGE_DIR, {
    match: (entry) => entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'),
    maxDepth: 2,
  });
  for (const filePath of files) {
    if (filePath.includes(`${path.sep}chatSessions${path.sep}`)) {
      const hashDir = path.dirname(path.dirname(filePath));
      results.push({ filePath, hashDir });
    }
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function parseVscodeCopilotSessions(_options?: SessionParseOptions): Promise<UnifiedSession[]> {
  const files = await findChatSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const { filePath, hashDir } of files) {
    try {
      const stats = fs.statSync(filePath);
      const cwd = extractCwd(path.join(hashDir, 'workspace.json'));

      if (filePath.endsWith('.jsonl')) {
        const parsed = await parseJsonlSession(filePath);
        if (!parsed || parsed.turns.length === 0) continue;

        const { meta, title, turns, lastTimestamp } = parsed;
        const firstUserText = turns[0]?.message?.text?.trim() ?? '';
        const summary = (title || firstUserText).slice(0, 80).replace(/\s+/g, ' ').trim() || undefined;

        sessions.push({
          id: meta.sessionId ?? path.basename(filePath, '.jsonl'),
          source: 'vscode-copilot',
          cwd,
          summary,
          lines: turns.length * 2,
          bytes: stats.size,
          createdAt: new Date(meta.creationDate ?? stats.birthtimeMs),
          updatedAt: new Date(lastTimestamp || meta.lastMessageDate || stats.mtimeMs),
          originalPath: filePath,
          model: extractModelFromTurns(turns),
        });
      } else {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as VscodeChatSessionJson;
        const requests = data.requests ?? [];
        if (requests.length === 0) continue;

        const firstUserText = requests[0]?.message?.text?.trim() ?? '';
        const summary = (data.customTitle ?? firstUserText).slice(0, 80).replace(/\s+/g, ' ').trim() || undefined;

        sessions.push({
          id: data.sessionId ?? path.basename(filePath, '.json'),
          source: 'vscode-copilot',
          cwd,
          summary,
          lines: requests.length * 2,
          bytes: stats.size,
          createdAt: new Date(data.creationDate ?? stats.birthtimeMs),
          updatedAt: new Date(data.lastMessageDate ?? stats.mtimeMs),
          originalPath: filePath,
          model: extractModelFromRequests(requests),
        });
      }
    } catch (err) {
      logger.debug('vscode-copilot: skipping unparseable session', filePath, err);
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function extractVscodeCopilotContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');

  let recentMessages: ConversationMessage[];

  if (session.originalPath.endsWith('.jsonl')) {
    const parsed = await parseJsonlSession(session.originalPath);
    recentMessages = parsed ? messagesFromTurns(parsed.turns) : [];
  } else {
    const data = JSON.parse(fs.readFileSync(session.originalPath, 'utf-8')) as VscodeChatSessionJson;
    recentMessages = messagesFromRequests(data.requests ?? []);
  }

  const trimmed = trimMessages(recentMessages, resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(session, trimmed, [], [], [], undefined, resolvedConfig, 'inline');

  return {
    session,
    recentMessages: trimmed,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    markdown,
  };
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionParseOptions, UnifiedSession } from '../types/index.js';
import { findFiles } from '../utils/fs-helpers.js';
import { readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import { fetchSummary, fileSummary, grepSummary, mcpSummary, searchSummary, shellSummary, subagentSummary, SummaryCollector } from '../utils/tool-summarizer.js';

function getVibeSessionsDir(): string {
  const configured = process.env.VIBE_HOME?.trim();
  const base = configured ? path.resolve(configured) : path.join(homeDir(), '.vibe');
  return path.join(base, 'logs', 'session');
}

const VIBE_SESSIONS_DIR = getVibeSessionsDir();

interface VibeMeta {
  session_id?: string;
  start_time?: string;
  end_time?: string;
  title?: string;
  environment?: { working_directory?: string };
  git_branch?: string;
  config?: { active_model?: string };
}

interface VibeToolCall {
  function?: { name?: string; arguments?: string };
}

interface VibeMessage {
  role?: string;
  content?: string;
  injected?: boolean;
  tool_calls?: VibeToolCall[];
  name?: string;
  tool_call_id?: string;
}

function extractConversationMessages(messages: VibeMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    if (msg.injected) continue;
    const text = msg.content?.trim() ?? '';
    if (!text) continue;
    result.push({ role: msg.role as 'user' | 'assistant', content: text });
  }
  return result;
}

export async function parseMistralVibeSessions(_options?: SessionParseOptions): Promise<UnifiedSession[]> {
  if (!fs.existsSync(VIBE_SESSIONS_DIR)) return [];

  const sessionDirs = findFiles(VIBE_SESSIONS_DIR, {
    match: (entry) => entry.name === 'meta.json',
    maxDepth: 2,
  }).map((f) => path.dirname(f));

  const sessions: UnifiedSession[] = [];

  for (const dir of sessionDirs) {
    try {
      const metaPath = path.join(dir, 'meta.json');
      const messagesPath = path.join(dir, 'messages.jsonl');
      if (!fs.existsSync(messagesPath)) continue;

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as VibeMeta;
      const stats = fs.statSync(messagesPath);

      const cwd = meta.environment?.working_directory ?? '';
      const createdAt = new Date(meta.start_time ?? stats.birthtimeMs);
      const updatedAt = new Date(meta.end_time ?? stats.mtimeMs);

      // Scan only the first ~30 lines to get summary without reading the full file.
      // meta.title is preferred; fall back to the first non-injected user message.
      let firstUserText = '';
      let hasConversation = false;
      await scanJsonlHead(messagesPath, 30, (parsed) => {
        const msg = parsed as VibeMessage;
        if (msg.injected || (msg.role !== 'user' && msg.role !== 'assistant')) return 'continue';
        const text = msg.content?.trim() ?? '';
        if (!text) return 'continue';
        hasConversation = true;
        if (msg.role === 'user' && !firstUserText) firstUserText = text;
        return firstUserText ? 'stop' : 'continue';
      });
      if (!hasConversation) continue;

      const summary =
        (meta.title && meta.title.length > 0 ? meta.title : firstUserText).slice(0, 80).replace(/\s+/g, ' ').trim() ||
        undefined;

      sessions.push({
        id: meta.session_id ?? path.basename(dir),
        source: 'mistral-vibe',
        cwd,
        repo: extractRepoFromCwd(cwd),
        branch: meta.git_branch,
        summary,
        lines: 0,
        bytes: stats.size,
        createdAt,
        updatedAt,
        originalPath: dir,
        model: meta.config?.active_model,
      });
    } catch (err) {
      logger.debug('mistral-vibe: skipping unparseable session', dir, err);
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function extractMistralVibeContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const collector = new SummaryCollector(resolvedConfig);

  const messagesPath = path.join(session.originalPath, 'messages.jsonl');
  const messages = await readJsonlFile<VibeMessage>(messagesPath);

  const recentMessages: ConversationMessage[] = [];

  for (const msg of messages) {
    if (msg.injected) continue;

    if ((msg.role === 'user' || msg.role === 'assistant') && msg.content?.trim()) {
      recentMessages.push({ role: msg.role as 'user' | 'assistant', content: msg.content.trim() });
    }

    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name ?? '';
        if (!name) continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          continue;
        }

        switch (name) {
          case 'bash': {
            const cmd = String(args.command ?? '').trim();
            if (cmd) collector.add('shell', shellSummary(cmd));
            break;
          }
          case 'read_file': {
            const filePath = String(args.path ?? '').trim();
            if (filePath) collector.add('read', fileSummary('read', filePath), { filePath });
            break;
          }
          case 'write_file': {
            const filePath = String(args.path ?? '').trim();
            if (filePath) collector.add('write', fileSummary('write', filePath), { filePath, isWrite: true });
            break;
          }
          case 'search_replace': {
            const filePath = String(args.file_path ?? '').trim();
            if (filePath) collector.add('edit', fileSummary('edit', filePath), { filePath, isWrite: true });
            break;
          }
          case 'grep': {
            const pattern = String(args.pattern ?? '').trim();
            const searchPath = String(args.path ?? '').trim();
            if (pattern) collector.add('grep', grepSummary(pattern, searchPath || undefined));
            break;
          }
          case 'web_search': {
            const query = String(args.query ?? '').trim();
            if (query) collector.add('search', searchSummary(query));
            break;
          }
          case 'web_fetch': {
            const url = String(args.url ?? '').trim();
            if (url) collector.add('fetch', fetchSummary(url));
            break;
          }
          case 'task': {
            const taskDesc = String(args.task ?? '').trim();
            const agent = String(args.agent ?? 'explore').trim();
            if (taskDesc) collector.add('task', subagentSummary(taskDesc.slice(0, 80), agent));
            break;
          }
          default: {
            collector.add('mcp', mcpSummary(name, JSON.stringify(args).slice(0, 80)));
            break;
          }
        }
      }
    }
  }

  const trimmed = trimMessages(recentMessages, resolvedConfig.recentMessages);
  const toolSummaries = collector.getSummaries();
  const filesModified = collector.getFilesModified();

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    [],
    toolSummaries,
    undefined,
    resolvedConfig,
    'inline',
  );

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks: [],
    toolSummaries,
    markdown,
  };
}

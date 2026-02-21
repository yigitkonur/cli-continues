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
import type { CodexMessage, CodexSessionMeta } from '../types/schemas.js';
import { findFiles } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepo, homeDir } from '../utils/parser-helpers.js';
import {
  mcpSummary,
  SummaryCollector,
  searchSummary,
  shellSummary,
  truncate,
  withResult,
} from '../utils/tool-summarizer.js';

const CODEX_SESSIONS_DIR = path.join(homeDir(), '.codex', 'sessions');

/**
 * Find all Codex session files recursively
 */
async function findSessionFiles(): Promise<string[]> {
  return findFiles(CODEX_SESSIONS_DIR, {
    match: (entry) => entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'),
  });
}

/**
 * Parse session metadata and first user message
 */
async function parseSessionInfo(filePath: string): Promise<{
  meta: CodexSessionMeta | null;
  firstUserMessage: string;
}> {
  let meta: CodexSessionMeta | null = null;
  let firstUserMessage = '';

  await scanJsonlHead(filePath, 150, (parsed) => {
    const msg = parsed as Record<string, unknown>;

    if (msg.type === 'session_meta' && !meta) {
      meta = msg as unknown as CodexSessionMeta;
    }

    if (!firstUserMessage && msg.type === 'event_msg') {
      const payload = msg.payload as Record<string, unknown> | undefined;
      if (payload?.type === 'user_message') {
        firstUserMessage = (payload.message as string) || '';
      }
    }

    if (!firstUserMessage && msg.type === 'message' && (msg as Record<string, unknown>).role === 'user') {
      firstUserMessage = typeof msg.content === 'string' ? (msg.content as string) : '';
    }

    return 'continue';
  });

  return { meta, firstUserMessage };
}

/**
 * Extract session ID and timestamp from filename
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
 */
function parseFilename(filename: string): { timestamp: Date; id: string } | null {
  const match = filename.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/);
  if (!match) return null;

  const [, year, month, day, hour, min, sec, id] = match;
  const timestamp = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);

  return { timestamp, id };
}

/**
 * Parse all Codex sessions
 */
export async function parseCodexSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const filename = path.basename(filePath);
      const parsed = parseFilename(filename);
      if (!parsed) continue;

      const { meta, firstUserMessage } = await parseSessionInfo(filePath);
      const stats = await getFileStats(filePath);
      const fileStats = fs.statSync(filePath);

      const cwd = meta?.payload?.cwd || '';
      const gitUrl = meta?.payload?.git?.repository_url;
      const branch = meta?.payload?.git?.branch;
      const repo = extractRepo({ gitUrl, cwd });

      const summary = cleanSummary(firstUserMessage);

      sessions.push({
        id: parsed.id,
        source: 'codex',
        cwd,
        repo,
        branch,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: parsed.timestamp,
        updatedAt: fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
      });
    } catch (err) {
      logger.debug('codex: skipping unparseable session', filePath, err);
      // Skip files we can't parse
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Read all messages from a Codex session
 */
async function readAllMessages(filePath: string): Promise<CodexMessage[]> {
  return readJsonlFile<CodexMessage>(filePath);
}

/**
 * Common shell tool base commands for category grouping
 */
const COMMON_SHELL_TOOLS = new Set([
  'npm',
  'git',
  'node',
  'python',
  'find',
  'grep',
  'cat',
  'ls',
  'tree',
  'mkdir',
  'rm',
  'sed',
  'awk',
  'curl',
  'wget',
  'docker',
  'make',
  'cargo',
  'go',
  'pip',
  'pnpm',
  'yarn',
  'bun',
  'deno',
]);

/**
 * Track file modifications from shell command patterns (sed -i, >, tee, mv, cp)
 */
function trackShellFileWrites(cmd: string, collector: SummaryCollector): void {
  const sedMatch = cmd.match(/sed\s+-i[^'"]*\s+[^'"]*\s+['"]?([^\s'"]+)/);
  if (sedMatch) {
    collector.trackFile(sedMatch[1]);
    return;
  }
  const redirectMatch = cmd.match(/>\s*['"]?([^\s;|&'"]+)/);
  if (redirectMatch && !redirectMatch[1].startsWith('>')) {
    collector.trackFile(redirectMatch[1]);
    return;
  }
  const teeMatch = cmd.match(/tee\s+['"]?([^\s;|&'"]+)/);
  if (teeMatch) {
    collector.trackFile(teeMatch[1]);
    return;
  }
  const mvCpMatch = cmd.match(/^(mv|cp)\s+.*\s+['"]?([^\s;|&'"]+)$/);
  if (mvCpMatch) {
    collector.trackFile(mvCpMatch[2]);
  }
}

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector
 */
function extractToolData(messages: CodexMessage[]): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector();
  const outputsById = new Map<string, string>();

  // First pass: collect function_call_output and custom_tool_call_output by call_id
  for (const msg of messages) {
    if (msg.type !== 'response_item') continue;
    const payload = msg.payload;
    if (
      (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') &&
      payload.call_id &&
      payload.output
    ) {
      outputsById.set(
        payload.call_id,
        typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output),
      );
    }
  }

  // Second pass: extract tool calls
  for (const msg of messages) {
    if (msg.type === 'response_item') {
      const payload = msg.payload;
      if (!payload) continue;

      // function_call
      if (payload.type === 'function_call' && payload.arguments) {
        try {
          const args = JSON.parse(payload.arguments);
          const name = payload.name || '';
          const output = payload.call_id ? outputsById.get(payload.call_id) : undefined;

          if (name === 'exec_command' || name === 'shell_command') {
            const cmd = String(args.cmd || args.command || '');
            if (!cmd) continue;
            const baseCmd = cmd.trim().split(/\s+/)[0];
            const category = COMMON_SHELL_TOOLS.has(baseCmd) ? baseCmd : 'shell';
            collector.add(category, shellSummary(cmd, output));
            trackShellFileWrites(cmd, collector);
          } else if (name === 'write_stdin') {
            collector.add('write_stdin', `stdin: "${truncate(String(args.input || args.data || ''), 60)}"`);
          } else if (['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates'].includes(name)) {
            collector.add('mcp-resource', `${name}: ${truncate(String(args.uri || args.server_label || '(all)'), 60)}`);
          } else if (name === 'request_user_input') {
            collector.add('user-input', `ask: "${truncate(String(args.prompt || args.message || ''), 60)}"`);
          } else if (name === 'update_plan') {
            collector.add('plan', `plan: "${truncate(String(args.explanation || ''), 60)}"`);
          } else if (name === 'view_image') {
            collector.add('view_image', `image: ${truncate(String(args.path || args.url || ''), 60)}`);
          } else if (name.startsWith('mcp__') || name.includes('-')) {
            collector.add(name, mcpSummary(name, JSON.stringify(args).slice(0, 100), output));
          } else {
            collector.add(name, withResult(`${name}(${JSON.stringify(args).slice(0, 80)})`, output));
          }
        } catch (err) {
          logger.debug('codex: skipping unparseable tool arguments', err);
        }
      }

      // custom_tool_call (e.g. apply_patch)
      if (payload.type === 'custom_tool_call' && payload.name) {
        const name = payload.name;
        const input = payload.input || '';
        if (name === 'apply_patch') {
          const fileMatches = input.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/g) || [];
          const files = fileMatches.map((m: string) => m.replace(/^\*\*\* (?:Add|Update|Delete) File: /, ''));
          const fileList = files.length > 0 ? files.slice(0, 3).join(', ') : '(patch)';
          collector.add('apply_patch', `patch: ${truncate(fileList, 70)}`);
          for (const f of files) collector.trackFile(f);
        } else {
          collector.add(name, `${name}: ${truncate(input, 80)}`);
        }
      }

      // web_search_call
      if (payload.type === 'web_search_call') {
        collector.add('web_search', searchSummary(String(payload.action?.query || payload.action?.queries?.[0] || '')));
      }
    } else if (msg.type === 'event_msg') {
      // Task lifecycle events
      const payload = msg.payload;
      if (!payload) continue;
      if (payload.type === 'task_started') {
        collector.add('task', `task: started "${truncate(payload.message || '', 60)}"`);
      } else if (payload.type === 'task_complete') {
        collector.add('task', 'task: completed');
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes from reasoning events, model, and token usage
 */
function extractSessionNotes(messages: CodexMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  for (const msg of messages) {
    // Model from turn_context
    if (msg.type === 'turn_context') {
      if (msg.payload?.model && !notes.model) notes.model = msg.payload.model;
    }

    if (msg.type !== 'event_msg') continue;
    const payload = msg.payload;
    if (!payload) continue;

    if (payload.type === 'agent_reasoning' && reasoning.length < 5) {
      const text = payload.message || '';
      if (text.length > 20) {
        const firstLine = text.split(/[.\n]/)[0]?.trim();
        if (firstLine) reasoning.push(truncate(firstLine, 200));
      }
    }

    // Token usage (take last value — cumulative)
    if (payload.type === 'token_count') {
      notes.tokenUsage = { input: payload.input_tokens || 0, output: payload.output_tokens || 0 };
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Extract context from a Codex session for cross-tool continuation
 */
export async function extractCodexContext(session: UnifiedSession): Promise<SessionContext> {
  const messages = await readAllMessages(session.originalPath);

  const { summaries: toolSummaries, filesModified } = extractToolData(messages);
  const sessionNotes = extractSessionNotes(messages);
  const pendingTasks: string[] = [];

  // Codex sessions contain both response_item and event_msg for the same conversation turns.
  // Collect from both sources separately to avoid duplicates, then merge preferring response_item.
  const eventMsgEntries: ConversationMessage[] = [];
  const responseItemEntries: ConversationMessage[] = [];

  for (const msg of messages) {
    if (msg.type === 'event_msg') {
      const payload = msg.payload;
      if (payload?.type === 'user_message') {
        const content = payload.message || msg.message || '';
        if (content) {
          eventMsgEntries.push({ role: 'user', content, timestamp: new Date(msg.timestamp) });
        }
      } else if (payload?.type === 'agent_message' || payload?.type === 'assistant_message') {
        const content = payload?.message || '';
        if (content) {
          eventMsgEntries.push({ role: 'assistant', content, timestamp: new Date(msg.timestamp) });
        }
      }
    } else if (msg.type === 'response_item') {
      const payload = msg.payload;
      if (payload?.role === 'user' && payload.type === 'message') {
        const contentParts = payload.content || [];
        const text = contentParts
          .filter((c) => c.type === 'input_text' && c.text)
          .map((c) => c.text)
          .join('\n');
        // Skip system-injected content (AGENTS.md instructions, environment_context, permissions)
        if (
          text &&
          !text.startsWith('<environment_context>') &&
          !text.startsWith('<permissions') &&
          !text.startsWith('# AGENTS.md')
        ) {
          responseItemEntries.push({ role: 'user', content: text, timestamp: new Date(msg.timestamp) });
        }
      } else if (payload?.role === 'assistant' && payload.type === 'message') {
        const contentParts = payload.content || [];
        const text = contentParts
          .filter((c) => (c.type === 'output_text' || c.type === 'text') && c.text)
          .map((c) => c.text)
          .join('\n');
        if (text) {
          responseItemEntries.push({ role: 'assistant', content: text, timestamp: new Date(msg.timestamp) });
        }
      }
      // Skip payload.type === 'reasoning' (chain-of-thought, not a message)
      // Skip payload.role === 'developer' (system instructions)
    }
  }

  // Prefer response_item entries (newer, richer format) when available; fall back to event_msg
  const hasResponseItems =
    responseItemEntries.some((m) => m.role === 'user') || responseItemEntries.some((m) => m.role === 'assistant');
  const allMessages = hasResponseItems ? responseItemEntries : eventMsgEntries;

  // Build a balanced tail: keep the last 10 messages but ensure user messages aren't lost.
  // Codex sessions can have many consecutive assistant messages (status updates, subagent reports).
  let trimmed: ConversationMessage[];
  const tail = allMessages.slice(-10);
  const hasUser = tail.some((m) => m.role === 'user');
  if (hasUser || allMessages.length <= 10) {
    trimmed = tail;
  } else {
    // Include the last user message + everything after it, capped at 10
    let lastUserIdx = -1;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      trimmed = allMessages.slice(lastUserIdx, lastUserIdx + 10);
    } else {
      trimmed = tail;
    }
  }

  // Generate markdown for injection
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

// generateHandoffMarkdown is imported from ../utils/markdown.js

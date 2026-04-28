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
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import type { CodexMessage, CodexSessionMeta } from '../types/schemas.js';
import { countDiffStats, extractStdoutTail } from '../utils/diff.js';
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepo, homeDir } from '../utils/parser-helpers.js';
import { matchesCwd } from '../utils/slug.js';
import {
  extractExitCode,
  fileSummary,
  mcpSummary,
  SummaryCollector,
  searchSummary,
  shellSummary,
  truncate,
  withResult,
} from '../utils/tool-summarizer.js';

const CODEX_HOME_DIR = process.env.CODEX_HOME || path.join(homeDir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME_DIR, 'sessions');
const CODEX_ARCHIVED_SESSIONS_DIR = path.join(CODEX_HOME_DIR, 'archived_sessions');

const MAX_EXACT_LINE_COUNT_BYTES = 1024 * 1024;
const MAX_METADATA_SCAN_BYTES = 1024 * 1024;

/**
 * Find all Codex session files recursively
 */
async function findSessionFiles(): Promise<string[]> {
  return [CODEX_SESSIONS_DIR, CODEX_ARCHIVED_SESSIONS_DIR].flatMap((dir) =>
    findFiles(dir, {
      match: (entry) => entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'),
    }),
  );
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

  await scanJsonlHead(
    filePath,
    150,
    (parsed) => {
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

      if (meta && firstUserMessage) {
        return 'stop';
      }
      return 'continue';
    },
    { maxBytes: MAX_METADATA_SCAN_BYTES },
  );

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
export async function parseCodexSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const parsedSessions = await mapConcurrent(files, 16, async (filePath): Promise<UnifiedSession | null> => {
    try {
      const filename = path.basename(filePath);
      const parsed = parseFilename(filename);
      if (!parsed) return null;

      const { meta, firstUserMessage } = await parseSessionInfo(filePath);
      const fileStats = fs.statSync(filePath);
      const stats =
        options.lightweight || fileStats.size > MAX_EXACT_LINE_COUNT_BYTES
          ? { lines: 0, bytes: fileStats.size }
          : await getFileStats(filePath);

      const payloadRecord = meta?.payload as Record<string, unknown> | undefined;
      const cwd = meta?.payload?.cwd || '';
      if (options.cwd && cwd && !matchesCwd(cwd, options.cwd)) return null;

      const gitUrl = meta?.payload?.git?.repository_url;
      const branch = meta?.payload?.git?.branch;
      const gitSha = meta?.payload?.git?.commit_hash || meta?.payload?.git?.sha;
      const repo = extractRepo({ gitUrl, cwd });
      const lastTranscriptTimestamp =
        !options.lightweight && fileStats.size <= MAX_METADATA_SCAN_BYTES
          ? await extractLastCodexTimestamp(filePath)
          : undefined;

      const summary = cleanSummary(firstUserMessage);

      return {
        id: parsed.id,
        source: 'codex',
        cwd,
        repo,
        branch,
        gitSha,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt:
          parseValidDate(typeof payloadRecord?.timestamp === 'string' ? payloadRecord.timestamp : undefined) ??
          parseValidDate(meta?.timestamp) ??
          parsed.timestamp,
        updatedAt: lastTranscriptTimestamp ?? fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
      };
    } catch (err) {
      logger.debug('codex: skipping unparseable session', filePath, err);
      // Skip files we can't parse
      return null;
    }
  });

  const sessionsById = new Map<string, UnifiedSession>();
  for (const nextSession of parsedSessions) {
    if (!nextSession) continue;
    const existing = sessionsById.get(nextSession.id);
    if (!existing || existing.updatedAt.getTime() < nextSession.updatedAt.getTime()) {
      sessionsById.set(nextSession.id, nextSession);
    }
  }

  const sorted = Array.from(sessionsById.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return options.limit ? sorted.slice(0, options.limit) : sorted;
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

function isCodexEditTool(name: string): boolean {
  return name === 'edit_file' || name.endsWith('__edit_file');
}

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
function extractToolData(
  messages: CodexMessage[],
  config?: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);
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
          const args = JSON.parse(payload.arguments) as Record<string, unknown>;
          const rawName = payload.name || '';
          const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
          const name = namespace && !rawName.startsWith(namespace) ? `${namespace}${rawName}` : rawName;
          const output = payload.call_id ? outputsById.get(payload.call_id) : undefined;

          if (name === 'exec_command' || name === 'shell_command') {
            const cmd = String(args.cmd || args.command || '');
            if (!cmd) continue;
            const baseCmd = cmd.trim().split(/\s+/)[0];
            const category = COMMON_SHELL_TOOLS.has(baseCmd) ? baseCmd : 'shell';
            const exitCode = extractExitCode(output);
            const errored = exitCode !== undefined && exitCode !== 0;
            const stdoutTail = output ? extractStdoutTail(output, 5) : undefined;
            collector.add(category, shellSummary(cmd, output), {
              data: {
                category: 'shell',
                command: cmd,
                ...(exitCode !== undefined ? { exitCode } : {}),
                ...(stdoutTail ? { stdoutTail } : {}),
                ...(errored ? { errored } : {}),
              },
              isError: errored,
            });
            trackShellFileWrites(cmd, collector);
          } else if (name === 'write_stdin') {
            const stdin = String(args.chars ?? args.input ?? args.data ?? '');
            collector.add('write_stdin', `stdin: "${truncate(stdin, 60)}"`);
          } else if (isCodexEditTool(name)) {
            const filePath = String(args.path ?? args.file_path ?? '');
            const displayPath = filePath || '(unknown)';
            const codeEdit = typeof args.code_edit === 'string' ? args.code_edit : undefined;
            collector.add(name, withResult(fileSummary('edit', displayPath), output), {
              data: {
                category: 'edit',
                filePath: displayPath,
                ...(codeEdit ? { diff: codeEdit } : {}),
              },
              ...(filePath ? { filePath, isWrite: true } : {}),
            });
          } else if (['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates'].includes(name)) {
            collector.add(
              'mcp-resource',
              `${name}: ${truncate(String(args.uri || args.server_label || '(all)'), 60)}`,
              {
                data: { category: 'mcp', toolName: name, params: String(args.uri || args.server_label || '') },
              },
            );
          } else if (name === 'request_user_input') {
            const question = truncate(String(args.prompt || args.message || ''), 80);
            collector.add('user-input', `ask: "${question}"`, {
              data: { category: 'ask', question },
            });
          } else if (name === 'update_plan') {
            collector.add('plan', `plan: "${truncate(String(args.explanation || ''), 60)}"`);
          } else if (name === 'view_image') {
            collector.add('view_image', `image: ${truncate(String(args.path || args.url || ''), 60)}`);
          } else if (name.startsWith('mcp__') || name.includes('-')) {
            const params = JSON.stringify(args).slice(0, 100);
            collector.add(name, mcpSummary(name, params, output), {
              data: {
                category: 'mcp',
                toolName: name,
                params,
                ...(output ? { result: output.slice(0, 100) } : {}),
              },
            });
          } else {
            collector.add(name, withResult(`${name}(${JSON.stringify(args).slice(0, 80)})`, output), {
              data: {
                category: 'mcp',
                toolName: name,
                params: JSON.stringify(args).slice(0, 100),
                ...(output ? { result: output.slice(0, 100) } : {}),
              },
            });
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
          // Capture the patch content as diff (Codex patches are in unified diff-like format)
          const diff = input.length > 0 ? input : undefined;
          const diffStats = diff ? countDiffStats(diff) : undefined;
          collector.add('apply_patch', `patch: ${truncate(fileList, 70)}`, {
            data: {
              category: 'edit',
              filePath: files[0] || '(multiple)',
              ...(diff ? { diff } : {}),
              ...(diffStats ? { diffStats } : {}),
            },
            filePath: files[0],
            isWrite: true,
          });
          for (const f of files) collector.trackFile(f);
        } else {
          collector.add(name, `${name}: ${truncate(input, 80)}`);
        }
      }

      // web_search_call
      if (payload.type === 'web_search_call') {
        const query = String(payload.action?.query || payload.action?.queries?.[0] || '');
        collector.add('web_search', searchSummary(query), {
          data: { category: 'search', query },
        });
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes from reasoning events, model, and token usage
 */
function extractCodexCompactedText(payload: { message?: string } | undefined): string {
  if (!payload) return '';
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  return '';
}

function extractSessionNotes(messages: CodexMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  const readTokenUsage = (
    raw: unknown,
  ): { input: number; output: number; cached: number; reasoning?: number } | null => {
    if (!raw || typeof raw !== 'object') return null;
    const usage = raw as Record<string, unknown>;
    const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const cached = typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0;
    const reasoningTokens =
      typeof usage.reasoning_output_tokens === 'number' ? usage.reasoning_output_tokens : undefined;
    return { input, output, cached, ...(reasoningTokens !== undefined ? { reasoning: reasoningTokens } : {}) };
  };

  for (const msg of messages) {
    if (msg.type === 'session_meta') {
      const payload = msg.payload as Record<string, unknown> | undefined;
      const git = payload?.git && typeof payload.git === 'object' ? (payload.git as Record<string, unknown>) : {};
      notes.sourceMetadata = {
        ...(notes.sourceMetadata ?? {}),
        ...(typeof payload?.id === 'string' ? { sessionId: payload.id } : {}),
        ...(typeof payload?.timestamp === 'string' ? { sessionTimestamp: payload.timestamp } : {}),
        ...(typeof msg.timestamp === 'string' ? { rolloutTimestamp: msg.timestamp } : {}),
        ...(typeof payload?.source === 'string' ? { source: payload.source } : {}),
        ...(typeof payload?.originator === 'string' ? { originator: payload.originator } : {}),
        ...(typeof payload?.cli_version === 'string' ? { cliVersion: payload.cli_version } : {}),
        ...(typeof payload?.model_provider === 'string' ? { modelProvider: payload.model_provider } : {}),
        ...(typeof git.commit_hash === 'string'
          ? { gitSha: git.commit_hash }
          : typeof git.sha === 'string'
            ? { gitSha: git.sha }
            : {}),
      };
      continue;
    }

    // Model from turn_context
    if (msg.type === 'turn_context') {
      if (msg.payload?.model && !notes.model) notes.model = msg.payload.model;
    }

    if (msg.type === 'compacted') {
      const summary = extractCodexCompactedText(msg.payload);
      if (summary) notes.compactSummary = truncate(summary, 500);
      continue;
    }

    if (msg.type !== 'event_msg') continue;
    const payload = msg.payload;
    if (!payload) continue;

    if (
      payload.type === 'task_started' ||
      payload.type === 'task_complete' ||
      payload.type === 'turn_aborted' ||
      payload.type === 'turn_completed'
    ) {
      if (!notes.lifecycle) notes.lifecycle = [];
      notes.lifecycle.push({
        type: payload.type,
        timestamp: msg.timestamp,
        message: payload.message,
        metadata: extractCodexLifecycleMetadata(payload),
      });
      continue;
    }

    if (payload.type === 'agent_reasoning' && reasoning.length < 5) {
      const text = payload.message || '';
      if (text.length > 20) {
        const firstLine = text.split(/[.\n]/)[0]?.trim();
        if (firstLine) reasoning.push(truncate(firstLine, 200));
      }
    }

    // Token usage (take last value — cumulative)
    if (payload.type === 'token_count') {
      const payloadRecord = payload as Record<string, unknown>;
      const info = payloadRecord.info as Record<string, unknown> | undefined;
      const usage =
        readTokenUsage(info?.total_token_usage) ?? readTokenUsage(info?.last_token_usage) ?? readTokenUsage(payload);

      if (usage) {
        notes.tokenUsage = { input: usage.input, output: usage.output };
        if (usage.cached > 0) {
          notes.cacheTokens = { creation: 0, read: usage.cached };
        }
        if (typeof usage.reasoning === 'number' && usage.reasoning > 0) {
          notes.thinkingTokens = usage.reasoning;
        }
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Extract context from a Codex session for cross-tool continuation
 */
export async function extractCodexContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const messages = await readAllMessages(session.originalPath);

  const { summaries: toolSummaries, filesModified } = extractToolData(messages, resolvedConfig);
  const sessionNotes = extractSessionNotes(messages);
  const pendingTasks: string[] = [];

  // Codex sessions contain both response_item and event_msg for the same conversation turns.
  // Collect from both sources separately to avoid duplicates, then merge preferring response_item.
  const eventMsgEntries: ConversationMessage[] = [];
  const responseItemEntries: ConversationMessage[] = [];
  const lifecycleEvents: SessionEvent[] = [];
  let lifecycleSequence = 0;

  for (const msg of messages) {
    if (msg.type === 'event_msg' && msg.payload) {
      const payload = msg.payload;
      if (
        payload.type === 'task_started' ||
        payload.type === 'task_complete' ||
        payload.type === 'turn_aborted' ||
        payload.type === 'turn_completed'
      ) {
        lifecycleEvents.push({
          kind: 'lifecycle',
          sequence: lifecycleSequence++,
          timestamp: parseValidDate(msg.timestamp),
          status: payload.type,
          content: payload.message,
          metadata: extractCodexLifecycleMetadata(payload),
        });
      }
    }

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

  // Build a balanced tail: keep the last N messages but ensure user messages aren't lost.
  // Codex sessions can have many consecutive assistant messages (status updates, subagent reports).
  let trimmed: ConversationMessage[];
  const tail = allMessages.slice(-resolvedConfig.recentMessages);
  const hasUser = tail.some((m) => m.role === 'user');
  if (hasUser || allMessages.length <= resolvedConfig.recentMessages) {
    trimmed = tail;
  } else {
    // Include the last user message + everything after it, capped at recentMessages
    let lastUserIdx = -1;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      trimmed = allMessages.slice(lastUserIdx, lastUserIdx + resolvedConfig.recentMessages);
    } else {
      trimmed = tail;
    }
  }

  // Build the timeline from the trimmed message set to reduce the chance that
  // older user turns are displaced before rendering. The final recent-activity
  // window is still sliced by event count, so a lifecycle-heavy tail can still
  // push the last user turn out of view.
  const timeline = buildCodexTimeline(trimmed, lifecycleEvents);

  // Generate markdown for injection
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
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

function parseValidDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function extractLastCodexTimestamp(filePath: string): Promise<Date | undefined> {
  let lastTimestamp: Date | undefined;
  await scanJsonlFile(
    filePath,
    (parsed) => {
      const timestamp = parseValidDate((parsed as { timestamp?: string }).timestamp);
      if (timestamp) lastTimestamp = timestamp;
      return 'continue';
    },
    { maxBytes: MAX_METADATA_SCAN_BYTES },
  );
  return lastTimestamp;
}

function extractCodexLifecycleMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of [
    'turn_id',
    'model_context_window',
    'reason',
    'collaboration_mode_kind',
    'started_at',
    'completed_at',
    'duration_ms',
  ]) {
    const value = payload[key];
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
}

function getFiniteTimestampMs(d?: Date): number | undefined {
  if (!d) return undefined;
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

const TIMELINE_KIND_ORDER: Record<string, number> = {
  message: 0,
  lifecycle: 1,
  reasoning: 2,
  tool_call: 3,
  tool_result: 4,
  metadata: 5,
  warning: 6,
};

function buildCodexTimeline(messages: ConversationMessage[], lifecycleEvents: SessionEvent[]): SessionEvent[] {
  const messageEvents: SessionEvent[] = messages.map(
    (message): SessionEvent => ({
      kind: 'message',
      sequence: 0, // assigned after merge
      role: message.role,
      content: message.content,
      // Drop non-finite (e.g. Invalid Date) so the comparator stays stable
      // and downstream toISOString() never throws.
      ...(getFiniteTimestampMs(message.timestamp) !== undefined ? { timestamp: message.timestamp } : {}),
    }),
  );
  const lifecycleSanitized = lifecycleEvents.map((event) =>
    getFiniteTimestampMs(event.timestamp) !== undefined ? event : { ...event, timestamp: undefined },
  );

  const indexed = [...messageEvents, ...lifecycleSanitized].map((event, originalIndex) => ({
    event,
    timestampMs: getFiniteTimestampMs(event.timestamp) ?? 0,
    kindOrder: TIMELINE_KIND_ORDER[event.kind] ?? 99,
    originalIndex,
  }));

  indexed.sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    if (a.kindOrder !== b.kindOrder) return a.kindOrder - b.kindOrder;
    return a.originalIndex - b.originalIndex;
  });

  // Assign sequence in final chronological order so windowing in markdown.ts is correct.
  return indexed.map(({ event }, index) => {
    event.sequence = index;
    return event;
  });
}

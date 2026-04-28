import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionEvent,
  StructuredToolSample,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import type { CopilotEvent, CopilotWorkspace } from '../types/schemas.js';
import { classifyToolName } from '../types/tool-names.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { homeDir, trimMessages } from '../utils/parser-helpers.js';
import {
  extractExitCode,
  fetchSummary,
  fileSummary,
  globSummary,
  grepSummary,
  mcpSummary,
  SummaryCollector,
  searchSummary,
  shellSummary,
  truncate,
  withResult,
} from '../utils/tool-summarizer.js';

interface CopilotToolInvocation {
  name: string;
  arguments: Record<string, unknown>;
  order: number;
  resultText?: string;
  resultDetail?: string;
  success?: boolean;
}

function getCopilotRoot(): string {
  const configuredHome = process.env.COPILOT_HOME?.trim();
  return configuredHome || path.join(homeDir(), '.copilot');
}

function getCopilotSessionsDir(): string {
  return path.join(getCopilotRoot(), 'session-state');
}

/**
 * Find all Copilot session directories
 */
async function findSessionDirs(): Promise<string[]> {
  const sessionsDir = getCopilotSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];
  return listSubdirectories(sessionsDir).filter((dir) => fs.existsSync(path.join(dir, 'workspace.yaml')));
}

/**
 * Parse workspace.yaml file
 */
function parseWorkspace(workspacePath: string): CopilotWorkspace | null {
  try {
    const content = fs.readFileSync(workspacePath, 'utf8');
    return YAML.parse(content) as CopilotWorkspace;
  } catch (err) {
    logger.debug('copilot: failed to parse workspace YAML', workspacePath, err);
    return null;
  }
}

/**
 * Extract model from events.jsonl.
 *
 * `selectedModel` is set on session.start (early in the file); `currentModel` is also
 * written on session.shutdown events at the END of the file. Real Copilot sessions where
 * the model field doesn't appear in the first 50 lines were missing it entirely. Scan up
 * to 1 MiB and prefer selectedModel (early return on first match), falling back to the
 * latest currentModel observed during the bounded scan.
 */
async function extractModel(eventsPath: string): Promise<string | undefined> {
  let selected: string | undefined;
  let latestCurrent: string | undefined;

  await scanJsonlFile(
    eventsPath,
    (parsed) => {
      const event = parsed as CopilotEvent;
      if (event.data?.selectedModel) {
        selected = event.data.selectedModel;
        return 'stop';
      }
      if (event.data?.currentModel) {
        latestCurrent = event.data.currentModel;
      }
      return 'continue';
    },
    { maxBytes: 1024 * 1024 },
  );

  return selected ?? latestCurrent;
}

/**
 * Parse all Copilot sessions
 */
export async function parseCopilotSessions(): Promise<UnifiedSession[]> {
  const dirs = await findSessionDirs();
  const sessions: UnifiedSession[] = [];

  for (const sessionDir of dirs) {
    try {
      const workspacePath = path.join(sessionDir, 'workspace.yaml');
      const eventsPath = path.join(sessionDir, 'events.jsonl');

      const workspace = parseWorkspace(workspacePath);
      if (!workspace) continue;

      const eventsExist = fs.existsSync(eventsPath);
      const stats = eventsExist ? await getFileStats(eventsPath) : { lines: 0, bytes: 0 };
      const model = eventsExist ? await extractModel(eventsPath) : undefined;
      const lastEventTimestamp = eventsExist ? await extractLastEventTimestamp(eventsPath, stats.bytes) : undefined;

      let summary = workspace.summary || '';
      if (summary.startsWith('|')) {
        summary = summary.replace(/^\|\n?/, '').split('\n')[0];
      }

      sessions.push({
        id: workspace.id,
        source: 'copilot',
        cwd: workspace.cwd,
        repo: workspace.repository,
        branch: workspace.branch,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: new Date(workspace.created_at),
        updatedAt: lastEventTimestamp ?? new Date(workspace.updated_at),
        originalPath: sessionDir,
        summary: summary.slice(0, 60),
        model,
      });
    } catch (err) {
      logger.debug('copilot: skipping unparseable session', sessionDir, err);
      // Skip sessions we can't parse
    }
  }

  return sessions.filter((s) => s.bytes > 0).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Copilot session for cross-tool continuation
 */
export async function extractCopilotContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const eventsPath = path.join(session.originalPath, 'events.jsonl');
  const events = await readJsonlFile<CopilotEvent>(eventsPath);

  const recentMessages: ConversationMessage[] = [];
  const pendingTasks: string[] = [];

  // First pass: collect messages only, so trimMessages can run before timeline construction.
  // Tool-heavy assistant turns produce many tool_call/tool_result events that, if added to the
  // timeline alongside untrimmed messages, get evicted by renderer's slice(-timelineWindow).
  // Copilot tails often contain only tool execution events.
  for (const event of events) {
    if (event.type === 'user.message') {
      const content = event.data?.content || event.data?.transformedContent || '';
      if (content) {
        recentMessages.push({
          role: 'user',
          content,
          timestamp: new Date(event.timestamp),
          sourceId: event.id,
          sourceParentId: event.parentId ?? undefined,
        });
      }
    } else if (event.type === 'assistant.message') {
      const content = event.data?.content || '';
      const toolRequests = event.data?.toolRequests || [];
      const toolCalls =
        toolRequests.length > 0
          ? toolRequests.map((t) => ({ name: t.name, arguments: getCopilotToolArguments(t) }))
          : undefined;

      if (content) {
        recentMessages.push({
          role: 'assistant',
          content: typeof content === 'string' ? content : JSON.stringify(content),
          timestamp: new Date(event.timestamp),
          sourceId: event.id,
          sourceParentId: event.parentId ?? undefined,
          toolCalls,
        });
      } else if (toolRequests.length > 0) {
        // Assistant message with only tool calls (no text content)
        const toolNames = toolRequests.map((t) => t.name).join(', ');
        recentMessages.push({
          role: 'assistant',
          content: `[Used tools: ${toolNames}]`,
          timestamp: new Date(event.timestamp),
          sourceId: event.id,
          sourceParentId: event.parentId ?? undefined,
          toolCalls,
        });
      }
    }
  }

  // If no conversation messages were found, synthesize from workspace summary
  if (recentMessages.length === 0 && session.summary) {
    recentMessages.push({
      role: 'user',
      content: session.summary,
      timestamp: session.createdAt,
    });
    recentMessages.push({
      role: 'assistant',
      content: `[Session worked on: ${session.summary}]`,
      timestamp: session.updatedAt,
    });
  }

  // Extract tool summaries and file modifications from toolRequests across all events
  const { summaries: toolSummaries, filesModified } = extractCopilotToolSummaries(events, resolvedConfig);

  const trimmed = trimMessages(recentMessages, resolvedConfig.recentMessages);

  // Build timeline from trimmed messages so the user-retention guarantee survives the
  // renderer's slice(-timelineWindow). Tool events are anchored to retained messages by
  // parent id (not by time window) so the timeline composes with the trimmed message set:
  // tool.execution_start.parentId points to its assistant (or user) message, and
  // tool.execution_complete.parentId points to its tool.execution_start event.
  const trimmedIds = new Set<string>(
    trimmed.map((m) => m.sourceId).filter((id): id is string => typeof id === 'string'),
  );
  // Map tool.execution_start id → toolName so the matching tool.execution_complete
  // event can carry the correct toolName (the complete event payload doesn't repeat it).
  const emittedStartToolNames = new Map<string, string>();
  const timeline: SessionEvent[] = [];
  let sequence = 0;

  for (const event of events) {
    if (event.type === 'user.message') {
      if (!event.id || !trimmedIds.has(event.id)) continue;
      const content = event.data?.content || event.data?.transformedContent || '';
      if (!content) continue;
      timeline.push({
        kind: 'message',
        sequence: sequence++,
        role: 'user',
        content,
        timestamp: new Date(event.timestamp),
        sourceId: event.id,
        sourceParentId: event.parentId ?? undefined,
      });
    } else if (event.type === 'assistant.message') {
      const content = event.data?.content || '';
      const toolRequests = event.data?.toolRequests || [];
      const messageRetained = Boolean(event.id && trimmedIds.has(event.id));

      if (!messageRetained) continue;

      if (content) {
        timeline.push({
          kind: 'message',
          sequence: sequence++,
          role: 'assistant',
          content: typeof content === 'string' ? content : JSON.stringify(content),
          timestamp: new Date(event.timestamp),
          sourceId: event.id,
          sourceParentId: event.parentId ?? undefined,
        });
      } else if (toolRequests.length > 0) {
        const toolNames = toolRequests.map((t) => t.name).join(', ');
        timeline.push({
          kind: 'message',
          sequence: sequence++,
          role: 'assistant',
          content: `[Used tools: ${toolNames}]`,
          timestamp: new Date(event.timestamp),
          sourceId: event.id,
          sourceParentId: event.parentId ?? undefined,
        });
      }

      // Inline tool requests on the assistant message — emit only when the
      // assistant message itself is retained. Each sibling gets a distinct
      // sourceId so they can be told apart, parented to the assistant message.
      for (const [index, toolRequest] of toolRequests.entries()) {
        const toolRequestId =
          getOptionalString((toolRequest as { id?: unknown }).id) ?? `${event.id}:toolRequest:${index}`;
        timeline.push({
          kind: 'tool_call',
          sequence: sequence++,
          timestamp: new Date(event.timestamp),
          sourceId: toolRequestId,
          sourceParentId: event.id,
          toolName: toolRequest.name,
          arguments: getCopilotToolArguments(toolRequest),
        });
      }
    } else if (event.type === 'tool.execution_start') {
      // Anchor by id: tool.execution_start.parentId references its parent message.
      // Emit only when the parent message is in the trimmed set.
      const parentId = event.parentId ?? undefined;
      if (!parentId || !trimmedIds.has(parentId)) continue;
      const toolName = getOptionalString(event.data?.toolName);
      if (toolName) {
        if (event.id) emittedStartToolNames.set(event.id, toolName);
        timeline.push({
          kind: 'tool_call',
          sequence: sequence++,
          timestamp: new Date(event.timestamp),
          sourceId: event.id,
          sourceParentId: event.parentId ?? undefined,
          toolName,
          toolCallId: getOptionalString(event.data?.toolCallId),
          arguments: normalizeCopilotArguments(event.data?.arguments),
        });
      }
    } else if (event.type === 'tool.execution_complete') {
      // Anchor by id: tool.execution_complete.parentId references its
      // tool.execution_start event. Emit only when that start was emitted.
      const parentId = event.parentId ?? undefined;
      if (!parentId) continue;
      const startToolName = emittedStartToolNames.get(parentId);
      if (!startToolName) continue;
      const result = extractCopilotResult(event.data?.result);
      timeline.push({
        kind: 'tool_result',
        sequence: sequence++,
        timestamp: new Date(event.timestamp),
        sourceId: event.id,
        sourceParentId: event.parentId ?? undefined,
        toolName: startToolName,
        toolCallId: getOptionalString(event.data?.toolCallId),
        status: typeof event.data?.success === 'boolean' ? (event.data.success ? 'success' : 'error') : undefined,
        result: result.resultText ?? result.resultDetail,
      });
    }
  }

  // Generate markdown for injection
  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    undefined,
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
    timeline,
    markdown,
  };
}

/**
 * Extract tool usage summaries from Copilot assistant toolRequests and
 * enrich them with actual execution results when tool.execution_* events exist.
 */
function extractCopilotToolSummaries(
  events: CopilotEvent[],
  config: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);

  for (const invocation of mergeCopilotToolInvocations(events)) {
    const category = classifyToolName(invocation.name);
    if (!category) continue;

    const filePath = getCopilotFilePath(invocation.arguments);
    const data = buildCopilotSampleData(
      category,
      invocation.name,
      invocation.arguments,
      invocation.resultText,
      invocation.resultDetail,
      invocation.success,
    );

    collector.add(
      invocation.name,
      buildCopilotSummary(category, invocation.name, invocation.arguments, invocation.resultText, data),
      {
        data,
        ...(filePath ? { filePath } : {}),
        isWrite: (category === 'write' || category === 'edit') && Boolean(filePath),
        isError: invocation.success === false || (data.category === 'shell' && data.errored === true),
      },
    );
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/** Build the correct StructuredToolSample for a Copilot tool request based on its classified category */
function buildCopilotSampleData(
  category: import('../types/tool-names.js').ToolSampleCategory,
  name: string,
  args: Record<string, unknown>,
  resultText?: string,
  resultDetail?: string,
  success?: boolean,
): StructuredToolSample {
  const fp = getCopilotFilePath(args);
  const output = resultText || resultDetail || '';
  const exitCode = extractExitCode(resultDetail || resultText);
  const errored = success === false || (exitCode !== undefined && exitCode !== 0);
  switch (category) {
    case 'shell': {
      const stdoutTail = resultText ? truncate(resultText, 500) : undefined;
      return {
        category: 'shell',
        command: (args.command as string) || (args.cmd as string) || '',
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(stdoutTail ? { stdoutTail } : {}),
        ...(errored ? { errored } : {}),
        ...(errored && output ? { errorMessage: truncate(output, 200) } : {}),
      };
    }
    case 'read':
      return { category: 'read', filePath: fp };
    case 'write':
      return {
        category: 'write',
        filePath: fp,
        ...(errored && output ? { errorMessage: truncate(output, 200) } : {}),
      };
    case 'edit':
      return {
        category: 'edit',
        filePath: fp,
        ...(errored && output ? { errorMessage: truncate(output, 200) } : {}),
      };
    case 'grep':
      return {
        category: 'grep',
        pattern: (args.pattern as string) || (args.query as string) || '',
        ...(fp ? { targetPath: fp } : {}),
      };
    case 'glob':
      return { category: 'glob', pattern: (args.pattern as string) || fp };
    case 'search':
      return {
        category: 'search',
        query: (args.query as string) || '',
        ...(resultText ? { resultPreview: truncate(resultText, 100) } : {}),
      };
    case 'fetch':
      return {
        category: 'fetch',
        url: (args.url as string) || '',
        ...(resultText ? { resultPreview: truncate(resultText, 100) } : {}),
      };
    case 'task':
      return {
        category: 'task',
        description: (args.description as string) || '',
        ...(resultText ? { resultSummary: truncate(resultText, 100) } : {}),
      };
    case 'ask':
      return { category: 'ask', question: ((args.question as string) || '').slice(0, 80) };
    default:
      return {
        category: 'mcp',
        toolName: name,
        ...(Object.keys(args).length > 0 ? { params: JSON.stringify(args).slice(0, 100) } : {}),
        ...(resultText ? { result: truncate(resultText, 100) } : {}),
      };
  }
}

function mergeCopilotToolInvocations(events: CopilotEvent[]): CopilotToolInvocation[] {
  const planned: CopilotToolInvocation[] = [];
  const executionStarts = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  const executionOnly: CopilotToolInvocation[] = [];
  let order = 0;

  for (const event of events) {
    if (event.type === 'assistant.message') {
      for (const toolRequest of event.data?.toolRequests || []) {
        planned.push({
          name: toolRequest.name || 'unknown',
          arguments: getCopilotToolArguments(toolRequest),
          order: order++,
        });
      }
      continue;
    }

    if (event.type === 'tool.execution_start') {
      const toolCallId = getOptionalString(event.data?.toolCallId);
      const toolName = getOptionalString(event.data?.toolName);
      if (!toolCallId || !toolName) continue;
      executionStarts.set(toolCallId, {
        name: toolName,
        arguments: normalizeCopilotArguments(event.data?.arguments),
      });
      continue;
    }

    if (event.type !== 'tool.execution_complete') continue;

    const toolCallId = getOptionalString(event.data?.toolCallId);
    if (!toolCallId) continue;
    const start = executionStarts.get(toolCallId);
    if (!start) continue;

    const actual: CopilotToolInvocation = {
      name: start.name,
      arguments: start.arguments,
      order: order++,
      success: typeof event.data?.success === 'boolean' ? event.data.success : undefined,
      ...extractCopilotResult(event.data?.result),
    };

    const matched = findMatchingPlannedInvocation(planned, actual);
    if (matched) {
      matched.success = actual.success;
      matched.resultText = actual.resultText;
      matched.resultDetail = actual.resultDetail;
      if (Object.keys(matched.arguments).length === 0 && Object.keys(actual.arguments).length > 0) {
        matched.arguments = actual.arguments;
      }
    } else {
      executionOnly.push(actual);
    }
  }

  return [...planned, ...executionOnly].sort((a, b) => a.order - b.order);
}

function findMatchingPlannedInvocation(
  planned: CopilotToolInvocation[],
  actual: CopilotToolInvocation,
): CopilotToolInvocation | undefined {
  const exactMatch = planned.find(
    (candidate) =>
      candidate.resultText === undefined &&
      candidate.name === actual.name &&
      stableStringify(candidate.arguments) === stableStringify(actual.arguments),
  );
  if (exactMatch) return exactMatch;

  return planned.find((candidate) => candidate.resultText === undefined && candidate.name === actual.name);
}

function buildCopilotSummary(
  category: import('../types/tool-names.js').ToolSampleCategory,
  name: string,
  args: Record<string, unknown>,
  resultText: string | undefined,
  data: StructuredToolSample,
): string {
  const filePath = getCopilotFilePath(args);

  switch (category) {
    case 'shell':
      return shellSummary((args.command as string) || (args.cmd as string) || '', resultText);
    case 'read':
      return fileSummary('read', filePath);
    case 'write':
      return withResult(fileSummary('write', filePath), resultText);
    case 'edit':
      return withResult(fileSummary('edit', filePath), resultText);
    case 'grep':
      return withResult(
        grepSummary((args.pattern as string) || (args.query as string) || '', filePath || undefined),
        resultText,
      );
    case 'glob':
      return withResult(globSummary((args.pattern as string) || filePath), resultText);
    case 'search':
      return withResult(searchSummary((args.query as string) || ''), resultText);
    case 'fetch':
      return withResult(fetchSummary((args.url as string) || ''), resultText);
    case 'task':
      return withResult(`task "${truncate((args.description as string) || '', 60)}"`, resultText);
    case 'ask':
      return `ask "${truncate((data.category === 'ask' && data.question) || '', 80)}"`;
    default: {
      const argsStr = Object.keys(args).length > 0 ? JSON.stringify(args).slice(0, 100) : '';
      return mcpSummary(name, argsStr, resultText);
    }
  }
}

function extractCopilotResult(result: unknown): { resultText?: string; resultDetail?: string } {
  if (typeof result === 'string') {
    return { resultText: result };
  }

  if (!result || typeof result !== 'object') {
    return {};
  }

  const content = getOptionalString((result as { content?: unknown }).content);
  const detailedContent = getOptionalString((result as { detailedContent?: unknown }).detailedContent);
  const contentsText = extractCopilotContentsText((result as { contents?: unknown }).contents);
  return {
    ...(content ? { resultText: content } : contentsText ? { resultText: contentsText } : {}),
    ...(detailedContent ? { resultDetail: detailedContent } : contentsText ? { resultDetail: contentsText } : {}),
  };
}

function extractCopilotContentsText(contents: unknown): string | undefined {
  if (!Array.isArray(contents)) return undefined;

  const parts = contents
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return undefined;
      }
      return getOptionalString((item as { text?: unknown }).text);
    })
    .filter((part): part is string => Boolean(part));

  if (parts.length === 0) return undefined;
  return parts.join('\n');
}

function getCopilotFilePath(args: Record<string, unknown>): string {
  return getOptionalString(args.path) || getOptionalString(args.file_path) || '';
}

function getCopilotToolArguments(toolRequest: { args?: unknown; arguments?: unknown }): Record<string, unknown> {
  return {
    ...normalizeCopilotArguments(toolRequest.args),
    ...normalizeCopilotArguments(toolRequest.arguments),
  };
}

function normalizeCopilotArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// Cap the timestamp scan so discovery (called every list) stays fast on
// multi-MB events.jsonl files; falls back to workspace.updated_at on the rare
// session that exceeds the cap.
const MAX_TIMESTAMP_SCAN_BYTES = 1024 * 1024;

async function extractLastEventTimestamp(
  eventsPath: string,
  eventsFileSizeBytes?: number,
): Promise<Date | undefined> {
  // If the file exceeds the scan cap, scanJsonlFile would truncate mid-file and leave us
  // with some early timestamp instead of the actual last event. That would make active
  // large sessions appear oldest in lists. Skip the scan entirely so the caller's
  // `?? new Date(workspace.updated_at)` fallback fires. When the caller has already
  // stat'd the file (parseCopilotSessions), reuse that size to avoid a redundant statSync.
  let sizeBytes = eventsFileSizeBytes;
  if (sizeBytes === undefined) {
    try {
      sizeBytes = fs.statSync(eventsPath).size;
    } catch (err) {
      logger.debug('copilot: failed to stat events.jsonl for timestamp scan', eventsPath, err);
      return undefined;
    }
  }
  if (sizeBytes > MAX_TIMESTAMP_SCAN_BYTES) {
    return undefined;
  }

  let lastTimestamp: Date | undefined;
  await scanJsonlFile(
    eventsPath,
    (parsed) => {
      const event = parsed as CopilotEvent;
      const timestamp = event.timestamp ? new Date(event.timestamp) : undefined;
      if (timestamp && !Number.isNaN(timestamp.getTime())) {
        lastTimestamp = timestamp;
      }
      return 'continue';
    },
    { maxBytes: MAX_TIMESTAMP_SCAN_BYTES },
  );
  return lastTimestamp;
}

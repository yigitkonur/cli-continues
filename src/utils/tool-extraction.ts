/**
 * Shared tool extraction for parsers using Anthropic-style content blocks
 * (tool_use / tool_result). Used by Claude, Droid, and Cursor parsers.
 */
import type {
  AskSampleData,
  EditSampleData,
  FetchSampleData,
  GlobSampleData,
  GrepSampleData,
  McpSampleData,
  ReadSampleData,
  SearchSampleData,
  ShellSampleData,
  StructuredToolSample,
  TaskSampleData,
  ToolUsageSummary,
  WriteSampleData,
} from '../types/index.js';
import {
  ASK_TOOLS,
  EDIT_TOOLS,
  FETCH_TOOLS,
  GLOB_TOOLS,
  GREP_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  SHELL_TOOLS,
  SKIP_TOOLS,
  TASK_OUTPUT_TOOLS,
  TASK_TOOLS,
  WRITE_TOOLS,
} from '../types/tool-names.js';
import { countDiffStats, extractStdoutTail, formatEditDiff, formatNewFileDiff } from './diff.js';
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
  subagentSummary,
  truncate,
  withResult,
} from './tool-summarizer.js';

/** Minimal tool_use block shape — works across Claude, Droid, Cursor */
interface ToolUseItem {
  type: 'tool_use';
  id?: string;
  name: string;
  input?: Record<string, unknown>;
}

/** Minimal tool_result block shape */
interface ToolResultItem {
  type: 'tool_result';
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

/** A message with content blocks (Anthropic format) */
export interface AnthropicMessage {
  role?: string;
  content: Array<{ type: string; [key: string]: unknown }>;
}

/** Stored tool result with full text and error flag */
interface ToolResultEntry {
  text: string;
  isError: boolean;
}

/** Max chars to store per tool result (generous for stdout/diffs) */
const MAX_RESULT_CHARS = 4000;

/**
 * Extract tool usage summaries and files modified from Anthropic-style messages.
 *
 * Works with any parser that uses tool_use / tool_result content blocks:
 * Claude, Droid, and Cursor all share this pattern.
 *
 * Two-pass approach:
 * 1. Collect all tool_result outputs by tool_use_id (with generous char limits)
 * 2. Process tool_use blocks with matched results, constructing structured data
 */
export function extractAnthropicToolData(messages: AnthropicMessage[]): {
  summaries: ToolUsageSummary[];
  filesModified: string[];
} {
  const collector = new SummaryCollector();
  const toolResultMap = new Map<string, ToolResultEntry>();

  // First pass: collect all tool_result blocks (generous limits for rich extraction)
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      if (item.type !== 'tool_result') continue;
      const tr = item as unknown as ToolResultItem;
      if (!tr.tool_use_id) continue;

      let text = '';
      if (typeof tr.content === 'string') {
        text = tr.content;
      } else if (Array.isArray(tr.content)) {
        text = tr.content.find((c) => c.type === 'text')?.text || '';
      }
      if (text) {
        toolResultMap.set(tr.tool_use_id, {
          text: text.slice(0, MAX_RESULT_CHARS),
          isError: tr.is_error === true,
        });
      }
    }
  }

  // Second pass: process tool_use blocks with structured data extraction
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      if (item.type !== 'tool_use') continue;
      const tu = item as unknown as ToolUseItem;
      const name = tu.name;
      if (!name || SKIP_TOOLS.has(name)) continue;

      const input = tu.input || {};
      const entry = tu.id ? toolResultMap.get(tu.id) : undefined;
      const result = entry?.text;
      const isError = entry?.isError ?? false;
      const fp = (input.file_path as string) || (input.path as string) || '';

      if (SHELL_TOOLS.has(name)) {
        const cmd = (input.command as string) || (input.cmd as string) || '';
        const exitCode = extractExitCode(result);
        const errored = isError || (exitCode !== undefined && exitCode !== 0);
        const stdoutTail = result ? extractStdoutTail(result, 5) : undefined;

        const data: ShellSampleData = {
          category: 'shell',
          command: cmd,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(stdoutTail ? { stdoutTail } : {}),
          ...(errored ? { errored } : {}),
        };
        collector.add('Bash', shellSummary(cmd, result), { data, isError: errored });
      } else if (READ_TOOLS.has(name)) {
        const lineStart = (input.offset as number) || (input.start_line as number) || undefined;
        const lineEnd = (input.limit as number)
          ? (lineStart || 1) + (input.limit as number) - 1
          : (input.end_line as number) || undefined;

        const data: ReadSampleData = {
          category: 'read',
          filePath: fp,
          ...(lineStart ? { lineStart } : {}),
          ...(lineEnd ? { lineEnd } : {}),
        };
        collector.add(name, withResult(fileSummary('read', fp), result?.slice(0, 80)), {
          data,
          filePath: fp,
        });
      } else if (WRITE_TOOLS.has(name)) {
        const content = (input.content as string) || '';
        let diff: string | undefined;
        let diffStats: { added: number; removed: number } | undefined;
        const isNewFile = true; // Write tool calls typically create new files

        if (content) {
          const diffResult = formatNewFileDiff(content, fp, 200);
          diff = diffResult.diff;
          diffStats = countDiffStats(diff);
        }

        const data: WriteSampleData = {
          category: 'write',
          filePath: fp,
          isNewFile,
          ...(diff ? { diff } : {}),
          ...(diffStats ? { diffStats } : {}),
        };
        collector.add(name, withResult(fileSummary('write', fp, diffStats, isNewFile), result?.slice(0, 80)), {
          data,
          filePath: fp,
          isWrite: true,
          isError,
        });
      } else if (EDIT_TOOLS.has(name)) {
        const oldStr = (input.old_string as string) || '';
        const newStr = (input.new_string as string) || '';
        let diff: string | undefined;
        let diffStats: { added: number; removed: number } | undefined;

        if (oldStr || newStr) {
          const diffResult = formatEditDiff(oldStr, newStr, fp, 200);
          diff = diffResult.diff;
          diffStats = countDiffStats(diff);
        }

        const data: EditSampleData = {
          category: 'edit',
          filePath: fp,
          ...(diff ? { diff } : {}),
          ...(diffStats ? { diffStats } : {}),
        };
        collector.add(name, withResult(fileSummary('edit', fp, diffStats), result?.slice(0, 80)), {
          data,
          filePath: fp,
          isWrite: true,
          isError,
        });
      } else if (GREP_TOOLS.has(name)) {
        const pattern = (input.pattern as string) || (input.query as string) || '';
        const targetPath = (input.path as string) || '';
        // Try to parse match count from result (e.g. "Found 5 files" or line count)
        const matchCount = result ? parseMatchCount(result) : undefined;

        const data: GrepSampleData = {
          category: 'grep',
          pattern,
          ...(targetPath ? { targetPath } : {}),
          ...(matchCount !== undefined ? { matchCount } : {}),
        };
        collector.add('Grep', withResult(grepSummary(pattern, targetPath), result?.slice(0, 80)), { data });
      } else if (GLOB_TOOLS.has(name)) {
        const pattern = (input.pattern as string) || (input.path as string) || '';
        const resultCount = result ? parseFileCount(result) : undefined;

        const data: GlobSampleData = {
          category: 'glob',
          pattern,
          ...(resultCount !== undefined ? { resultCount } : {}),
        };
        collector.add('Glob', withResult(globSummary(pattern), result?.slice(0, 80)), { data });
      } else if (FETCH_TOOLS.has(name)) {
        const url = (input.url as string) || '';
        const data: FetchSampleData = {
          category: 'fetch',
          url,
          ...(result ? { resultPreview: result.slice(0, 100) } : {}),
        };
        collector.add('WebFetch', fetchSummary(url), { data });
      } else if (SEARCH_TOOLS.has(name)) {
        const query = (input.query as string) || '';
        const data: SearchSampleData = { category: 'search', query };
        collector.add('WebSearch', searchSummary(query), { data });
      } else if (TASK_TOOLS.has(name)) {
        const description = (input.description as string) || '';
        const agentType = (input.subagent_type as string) || undefined;
        const data: TaskSampleData = {
          category: 'task',
          description,
          ...(agentType ? { agentType } : {}),
        };
        collector.add('Task', subagentSummary(description, agentType), { data });
      } else if (TASK_OUTPUT_TOOLS.has(name)) {
        const description = (input.content as string) || (input.result as string) || '';
        const agentType = (input.subagent_type as string) || undefined;
        const data: TaskSampleData = {
          category: 'task',
          description,
          ...(agentType ? { agentType } : {}),
          ...(result ? { resultSummary: result.slice(0, 100) } : {}),
        };
        collector.add('TaskOutput', subagentSummary(description, agentType), { data });
      } else if (ASK_TOOLS.has(name)) {
        const question = truncate((input.question as string) || (input.prompt as string) || '', 80);
        const data: AskSampleData = { category: 'ask', question };
        collector.add('AskUserQuestion', `ask: "${question}"`, { data });
      } else if (name.startsWith('mcp__') || name.includes('___') || name.includes('-')) {
        const params = truncateParams(input);
        const data: McpSampleData = {
          category: 'mcp',
          toolName: name,
          ...(params ? { params } : {}),
          ...(result ? { result: result.slice(0, 100) } : {}),
        };
        collector.add(name, mcpSummary(name, JSON.stringify(input).slice(0, 100), result?.slice(0, 80)), { data });
      } else {
        // Generic/unknown tool — treat as MCP-like
        const params = truncateParams(input);
        const data: McpSampleData = {
          category: 'mcp',
          toolName: name,
          ...(params ? { params } : {}),
          ...(result ? { result: result.slice(0, 100) } : {}),
        };
        collector.add(name, withResult(`${name}(${JSON.stringify(input).slice(0, 100)})`, result?.slice(0, 80)), {
          data,
        });
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Truncate each param value to 100 chars and format as compact string */
function truncateParams(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    const str = typeof val === 'string' ? val : JSON.stringify(val) ?? '';
    parts.push(`${key}=${truncate(str, 100)}`);
  }
  return parts.join(', ');
}

/** Parse match/file count from grep result text */
function parseMatchCount(result: string): number | undefined {
  // "Found N files" or "N matches" patterns
  const m = result.match(/(?:found|Found)\s+(\d+)/i) || result.match(/(\d+)\s+match/i);
  if (m) return parseInt(m[1]);
  // Count newlines as a rough proxy for match count
  const lines = result.split('\n').filter((l) => l.trim()).length;
  return lines > 0 ? lines : undefined;
}

/** Parse file count from glob result text */
function parseFileCount(result: string): number | undefined {
  const m = result.match(/(?:found|Found)\s+(\d+)/i) || result.match(/(\d+)\s+files?/i);
  if (m) return parseInt(m[1]);
  const lines = result.split('\n').filter((l) => l.trim()).length;
  return lines > 0 ? lines : undefined;
}

/**
 * Extract thinking/reasoning highlights from Anthropic-style messages.
 * Returns up to `maxHighlights` first-line summaries from thinking blocks.
 * Shared by Claude, Droid, and Cursor parsers.
 */
export function extractThinkingHighlights(messages: AnthropicMessage[], maxHighlights = 5): string[] {
  const reasoning: string[] = [];

  for (const msg of messages) {
    if (reasoning.length >= maxHighlights) break;
    if (!Array.isArray(msg.content)) continue;

    for (const item of msg.content) {
      if (reasoning.length >= maxHighlights) break;
      if (item.type !== 'thinking') continue;

      const text = (item as { thinking?: string; text?: string }).thinking || (item as { text?: string }).text || '';
      if (text.length > 20) {
        const firstLine = text.split(/[.\n]/)[0]?.trim();
        if (firstLine) reasoning.push(truncate(firstLine, 200));
      }
    }
  }

  return reasoning;
}

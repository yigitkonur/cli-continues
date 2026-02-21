/**
 * Shared tool extraction for parsers using Anthropic-style content blocks
 * (tool_use / tool_result). Used by Claude, Droid, and Cursor parsers.
 */
import type { ToolUsageSummary } from '../types/index.js';
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
import {
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
}

/** A message with content blocks (Anthropic format) */
export interface AnthropicMessage {
  role?: string;
  content: Array<{ type: string; [key: string]: unknown }>;
}

/**
 * Extract tool usage summaries and files modified from Anthropic-style messages.
 *
 * Works with any parser that uses tool_use / tool_result content blocks:
 * Claude, Droid, and Cursor all share this pattern.
 *
 * Two-pass approach:
 * 1. Collect all tool_result outputs by tool_use_id
 * 2. Process tool_use blocks with matched results
 */
export function extractAnthropicToolData(messages: AnthropicMessage[]): {
  summaries: ToolUsageSummary[];
  filesModified: string[];
} {
  const collector = new SummaryCollector();
  const toolResultMap = new Map<string, string>();

  // First pass: collect all tool_result blocks
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
      if (text) toolResultMap.set(tr.tool_use_id, text.slice(0, 100));
    }
  }

  // Second pass: process tool_use blocks
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      if (item.type !== 'tool_use') continue;
      const tu = item as unknown as ToolUseItem;
      const name = tu.name;
      if (!name || SKIP_TOOLS.has(name)) continue;

      const input = tu.input || {};
      const result = tu.id ? toolResultMap.get(tu.id) : undefined;
      const fp = (input.file_path as string) || (input.path as string) || '';

      if (SHELL_TOOLS.has(name)) {
        const cmd = (input.command as string) || (input.cmd as string) || '';
        collector.add('Bash', shellSummary(cmd, result));
      } else if (READ_TOOLS.has(name)) {
        collector.add(name, withResult(fileSummary('read', fp), result), fp);
      } else if (WRITE_TOOLS.has(name)) {
        collector.add(name, withResult(fileSummary('write', fp), result), fp, true);
      } else if (EDIT_TOOLS.has(name)) {
        collector.add(name, withResult(fileSummary('edit', fp), result), fp, true);
      } else if (GREP_TOOLS.has(name)) {
        collector.add(
          'Grep',
          withResult(
            grepSummary((input.pattern as string) || (input.query as string) || '', (input.path as string) || ''),
            result,
          ),
        );
      } else if (GLOB_TOOLS.has(name)) {
        collector.add(
          'Glob',
          withResult(globSummary((input.pattern as string) || (input.path as string) || ''), result),
        );
      } else if (FETCH_TOOLS.has(name)) {
        collector.add('WebFetch', fetchSummary((input.url as string) || ''));
      } else if (SEARCH_TOOLS.has(name)) {
        collector.add('WebSearch', searchSummary((input.query as string) || ''));
      } else if (TASK_TOOLS.has(name)) {
        collector.add(
          'Task',
          subagentSummary((input.description as string) || '', (input.subagent_type as string) || ''),
        );
      } else if (TASK_OUTPUT_TOOLS.has(name)) {
        collector.add(
          'TaskOutput',
          subagentSummary(
            (input.content as string) || (input.result as string) || '',
            (input.subagent_type as string) || '',
          ),
        );
      } else if (ASK_TOOLS.has(name)) {
        collector.add(
          'AskUserQuestion',
          `ask: "${truncate((input.question as string) || (input.prompt as string) || '', 80)}"`,
        );
      } else if (name.startsWith('mcp__') || name.includes('___') || name.includes('-')) {
        collector.add(name, mcpSummary(name, JSON.stringify(input).slice(0, 100), result));
      } else {
        collector.add(name, withResult(`${name}(${JSON.stringify(input).slice(0, 100)})`, result));
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
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

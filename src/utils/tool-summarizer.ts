/**
 * Shared tool call summarizer — formatting helpers + SummaryCollector.
 * Each parser normalizes its raw tool events and uses these utilities
 * for consistent, concise summaries across all 7 CLIs.
 */

import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import type { StructuredToolSample, ToolSample, ToolUsageSummary } from '../types/index.js';

// ── Formatting Helpers ──────────────────────────────────────────────────────

/** Truncate a string, adding '...' if it exceeds max length */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

/** Extract exit code from tool result text */
export function extractExitCode(text?: string): number | undefined {
  if (!text) return undefined;
  const m = text.match(/exit(?:ed with)? code[:\s]+(\d+)/i);
  return m ? parseInt(m[1], 10) : undefined;
}

/** Append ` → "result"` to a summary if result is non-empty */
export function withResult(summary: string, result?: string): string {
  if (!result) return summary;
  return `${summary} → "${truncate(result, 80)}"`;
}

/** Format a shell command invocation */
export function shellSummary(cmd: string, result?: string): string {
  let s = `$ ${truncate(cmd, 80)}`;
  const exitCode = extractExitCode(result);
  if (exitCode !== undefined) {
    s += ` → exit ${exitCode}`;
  } else if (result) {
    s += ` → "${truncate(result, 80)}"`;
  }
  return s;
}

/** Format a file operation (read/write/edit) */
export function fileSummary(
  op: 'read' | 'write' | 'edit',
  filePath: string,
  diffStat?: { added: number; removed: number },
  isNewFile?: boolean,
): string {
  let s = `${op} ${filePath}`;
  if (isNewFile) {
    s += ' (new file)';
  } else if (diffStat) {
    s += ` (+${diffStat.added} -${diffStat.removed} lines)`;
  }
  return s;
}

/** Format a grep invocation */
export function grepSummary(pattern: string, targetPath?: string): string {
  return `grep "${pattern}" ${targetPath || ''}`.trim();
}

/** Format a glob invocation */
export function globSummary(pattern: string): string {
  return `glob "${pattern}"`;
}

/** Format a web search */
export function searchSummary(query: string): string {
  return `search "${truncate(query, 60)}"`;
}

/** Format a web fetch */
export function fetchSummary(url: string): string {
  return `fetch ${truncate(url, 80)}`;
}

/** Format an MCP or generic tool call */
export function mcpSummary(name: string, argsStr: string, result?: string): string {
  let s = `${name}(${argsStr})`;
  if (result) s += ` → "${truncate(result, 80)}"`;
  return s;
}

/** Format a subagent/task invocation */
export function subagentSummary(desc: string, type?: string): string {
  if (type) return `task "${truncate(desc, 60)}" (${type})`;
  return `task-output: ${truncate(desc, 80)}`;
}

// ── SummaryCollector ────────────────────────────────────────────────────────

/** Build per-category sample limits from a VerbosityConfig */
function buildCategoryLimits(config: VerbosityConfig): Record<string, number> {
  return {
    // shell / bash
    Bash: config.shell.maxSamples,
    shell: config.shell.maxSamples,
    // write / create
    Write: config.write.maxSamples,
    write: config.write.maxSamples,
    // edit / patch
    Edit: config.edit.maxSamples,
    edit: config.edit.maxSamples,
    // read
    Read: config.read.maxSamples,
    read: config.read.maxSamples,
    // grep / glob / search / fetch
    Grep: config.grep.maxSamples,
    Glob: config.grep.maxSamples,
    WebSearch: config.grep.maxSamples,
    WebFetch: config.grep.maxSamples,
    // mcp / task / ask
    Task: config.mcp.maxSamplesPerNamespace,
    TaskOutput: config.mcp.maxSamplesPerNamespace,
    AskUserQuestion: config.mcp.maxSamplesPerNamespace,
  };
}

const DEFAULT_SAMPLE_LIMIT = 5;

/** Options for SummaryCollector.add() */
export interface AddSampleOptions {
  /** Structured data for rich rendering */
  data?: StructuredToolSample;
  /** File path associated with this invocation */
  filePath?: string;
  /** Whether this invocation modified the file */
  isWrite?: boolean;
  /** Whether this invocation resulted in an error */
  isError?: boolean;
}

/**
 * Accumulates tool call summaries by category (tool name).
 * Keeps up to N representative samples per category (category-aware limits)
 * and tracks files modified and error counts.
 */
export class SummaryCollector {
  private data = new Map<string, { count: number; errorCount: number; samples: ToolSample[] }>();
  private files = new Set<string>();
  private categoryLimits: Record<string, number>;

  constructor(config?: VerbosityConfig) {
    const resolved = config ?? getPreset('standard');
    this.categoryLimits = buildCategoryLimits(resolved);
  }

  /** Add a tool invocation. Optionally tracks file modification and errors. */
  add(category: string, summary: string, opts?: AddSampleOptions): void {
    if (!this.data.has(category)) {
      this.data.set(category, { count: 0, errorCount: 0, samples: [] });
    }
    const entry = this.data.get(category)!;
    entry.count++;
    if (opts?.isError) entry.errorCount++;

    const maxSamples = this.categoryLimits[category] ?? DEFAULT_SAMPLE_LIMIT;
    if (entry.samples.length < maxSamples) {
      const sample: ToolSample = { summary };
      if (opts?.data) sample.data = opts.data;
      entry.samples.push(sample);
    }

    if (opts?.isWrite && opts?.filePath) {
      this.files.add(opts.filePath);
    }
  }

  /** Track a file modification without adding a tool summary entry */
  trackFile(filePath: string): void {
    this.files.add(filePath);
  }

  /** Get aggregated tool usage summaries */
  getSummaries(): ToolUsageSummary[] {
    return Array.from(this.data.entries()).map(([name, { count, errorCount, samples }]) => ({
      name,
      count,
      ...(errorCount > 0 ? { errorCount } : {}),
      samples,
    }));
  }

  /** Get deduplicated list of files modified */
  getFilesModified(): string[] {
    return Array.from(this.files);
  }
}

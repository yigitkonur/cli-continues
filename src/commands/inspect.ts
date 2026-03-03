/**
 * `continues inspect <session-id>` — diagnostic command that runs the full
 * parsing pipeline and outputs detailed statistics showing what was parsed,
 * how much made it into the markdown, and conversion efficiency.
 *
 * Designed for verifying that nothing is silently dropped during extraction.
 */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getPreset, loadConfig } from '../config/index.js';
import type { VerbosityConfig } from '../config/index.js';
import { adapters } from '../parsers/registry.js';
import type { SessionContext, ReasoningStep, UnifiedSession } from '../types/index.js';
import { classifyToolName } from '../types/tool-names.js';
import { findSession } from '../utils/index.js';
import { readJsonlFile } from '../utils/jsonl.js';

// ── Format Detection ────────────────────────────────────────────────────────

type SessionFormat = 'jsonl' | 'json' | 'sqlite' | 'yaml';

function getSessionFormat(source: string): SessionFormat {
  switch (source) {
    case 'claude':
    case 'codex':
    case 'droid':
    case 'cursor':
    case 'antigravity':
      return 'jsonl';
    case 'gemini':
    case 'amp':
    case 'kiro':
    case 'cline':
    case 'roo-code':
    case 'kilo-code':
      return 'json';
    case 'crush':
    case 'opencode':
      return 'sqlite';
    case 'copilot':
      return 'yaml';
    default:
      return 'jsonl';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Format bytes into a human-readable string (KB, MB, GB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Render a simple bar chart using unicode blocks. Width = 30 chars. */
function bar(fraction: number, width = 30): string {
  const filled = Math.round(fraction * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Right-pad a string to a given width. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Right-align a number string to a given width. */
function rpad(n: number | string, width: number): string {
  const s = String(n);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Count lines in a file synchronously (fast newline count). */
function countLines(filePath: string): number {
  try {
    const buf = fs.readFileSync(filePath);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++;
    }
    // If file doesn't end with newline, count the last line
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) count++;
    return count;
  } catch {
    return 0;
  }
}

/** List files in a directory, returning dirent-like info. */
function listDir(dirPath: string): Array<{ name: string; size: number; lines: number }> {
  try {
    if (!fs.existsSync(dirPath)) return [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => {
        const fp = path.join(dirPath, e.name);
        const stats = fs.statSync(fp);
        return { name: e.name, size: stats.size, lines: countLines(fp) };
      });
  } catch {
    return [];
  }
}

// ── Content Block & Event Analysis ──────────────────────────────────────────

interface RawEventCounts {
  byType: Map<string, number>;
  total: number;
}

interface ContentBlockCounts {
  byType: Map<string, number>;
  total: number;
}

interface ToolCategoryCounts {
  byType: Map<string, number>;
  total: number;
}

interface SubagentFileInfo {
  name: string;
  lines: number;
  status: 'completed' | 'killed';
  toolCallCount: number;
}

interface ToolResultFileInfo {
  name: string;
  lines: number;
  size: number;
}

/**
 * Analyze raw JSONL messages for event distribution, content blocks,
 * and tool call categories.
 */
function analyzeRawMessages(
  messages: Array<Record<string, unknown>>,
): {
  events: RawEventCounts;
  blocks: ContentBlockCounts;
  tools: ToolCategoryCounts;
  model: string | undefined;
} {
  const eventMap = new Map<string, number>();
  const blockMap = new Map<string, number>();
  const toolMap = new Map<string, number>();
  let model: string | undefined;

  for (const msg of messages) {
    // Count event types
    const type = (msg.type as string) || 'unknown';
    eventMap.set(type, (eventMap.get(type) || 0) + 1);

    // Extract model
    if (!model && msg.model) {
      model = msg.model as string;
    }

    // Count content blocks from assistant and user messages
    const message = msg.message as { role?: string; content?: unknown } | undefined;
    if (!message?.content || !Array.isArray(message.content)) continue;

    for (const block of message.content as Array<{ type: string; name?: string }>) {
      const blockType = block.type || 'unknown';
      blockMap.set(blockType, (blockMap.get(blockType) || 0) + 1);

      // Classify tool_use blocks by category
      if (blockType === 'tool_use' && block.name) {
        const category = classifyToolName(block.name);
        if (category) {
          // Map to display labels
          const label = CATEGORY_LABELS[category] || category;
          toolMap.set(label, (toolMap.get(label) || 0) + 1);
        }
      }
    }
  }

  return {
    events: { byType: eventMap, total: messages.length },
    blocks: {
      byType: blockMap,
      total: Array.from(blockMap.values()).reduce((a, b) => a + b, 0),
    },
    tools: {
      byType: toolMap,
      total: Array.from(toolMap.values()).reduce((a, b) => a + b, 0),
    },
    model,
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  shell: 'Shell/Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep/Glob',
  glob: 'Grep/Glob',
  search: 'Search',
  fetch: 'Fetch',
  task: 'Task (subagent)',
  ask: 'Ask',
  mcp: 'MCP',
  reasoning: 'Reasoning',
};

// ── Subagent File Analysis (Claude-specific) ────────────────────────────────

async function analyzeSubagentFiles(sessionDir: string): Promise<SubagentFileInfo[]> {
  const subagentsDir = path.join(sessionDir, 'subagents');
  const files = listDir(subagentsDir);
  const results: SubagentFileInfo[] = [];

  for (const file of files) {
    if (!file.name.endsWith('.jsonl')) continue;
    const filePath = path.join(subagentsDir, file.name);

    try {
      const msgs = await readJsonlFile<Record<string, unknown>>(filePath);
      let toolCallCount = 0;
      let wasKilled = false;

      for (const m of msgs) {
        if (m.type !== 'assistant') continue;
        const message = m.message as { content?: Array<{ type: string }> } | undefined;
        if (!message?.content || !Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block.type === 'tool_use') toolCallCount++;
        }
        // Check for rate-limit/kill indicators
        const content = message.content as Array<{ type: string; text?: string }>;
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            const lower = block.text.toLowerCase();
            if (lower.includes('out of extra usage') || lower.includes('rate limit')) {
              wasKilled = true;
            }
          }
        }
      }

      results.push({
        name: file.name,
        lines: file.lines,
        status: wasKilled ? 'killed' : 'completed',
        toolCallCount,
      });
    } catch {
      results.push({
        name: file.name,
        lines: file.lines,
        status: 'killed',
        toolCallCount: 0,
      });
    }
  }

  return results;
}

// ── Markdown Stats ──────────────────────────────────────────────────────────

interface MarkdownStats {
  totalChars: number;
  sections: number;
  recentMessages: number;
  toolSummaries: number;
  subagentResults: number;
  reasoningSteps: number;
  pendingTasks: number;
  filesModified: number;
}

function computeMarkdownStats(ctx: SessionContext): MarkdownStats {
  const md = ctx.markdown;
  // Count sections by ## headings
  const sections = (md.match(/^## /gm) || []).length;

  return {
    totalChars: md.length,
    sections,
    recentMessages: ctx.recentMessages.length,
    toolSummaries: ctx.toolSummaries.length,
    subagentResults: ctx.sessionNotes?.subagentResults?.length || 0,
    reasoningSteps: ctx.sessionNotes?.reasoningSteps?.length || 0,
    pendingTasks: ctx.pendingTasks.length,
    filesModified: ctx.filesModified.length,
  };
}

// ── Output Rendering ────────────────────────────────────────────────────────

function renderHeader(sessionId: string): string {
  const line = '═'.repeat(66);
  return [
    '',
    chalk.bold(line),
    chalk.bold(`  SESSION INSPECTION: ${sessionId}`),
    chalk.bold(line),
    '',
  ].join('\n');
}

function renderSourceFiles(
  session: UnifiedSession,
  mainLines: number,
  mainSize: number,
  subagentFiles: SubagentFileInfo[],
  toolResultFiles: ToolResultFileInfo[],
): string {
  const lines: string[] = [chalk.cyan.bold('📂 Source Files')];

  lines.push(
    `  Main JSONL:   ${chalk.gray(session.originalPath)} (${mainLines} lines, ${formatBytes(mainSize)})`,
  );

  if (subagentFiles.length > 0) {
    const totalSubLines = subagentFiles.reduce((s, f) => s + f.lines, 0);
    lines.push(`  Subagents:    ${subagentFiles.length} files (${totalSubLines} total lines)`);
    for (const f of subagentFiles) {
      const statusIcon = f.status === 'completed' ? chalk.green('✓') : chalk.red('✗');
      const statusText = f.status === 'completed' ? 'completed' : 'killed';
      lines.push(
        `    ${pad(f.name, 30)} ${rpad(f.lines, 5)} lines    ${statusIcon} ${statusText} (${f.toolCallCount} tools)`,
      );
    }
  }

  if (toolResultFiles.length > 0) {
    const totalSize = toolResultFiles.reduce((s, f) => s + f.size, 0);
    lines.push(`  Tool Results: ${toolResultFiles.length} files (${formatBytes(totalSize)} total)`);
    for (const f of toolResultFiles) {
      lines.push(
        `    ${pad(f.name, 45)} ${rpad(f.lines, 5)} lines  (${formatBytes(f.size)})`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderEventDistribution(events: RawEventCounts, source: string): string {
  const lines: string[] = [chalk.cyan.bold(`📊 Raw Event Distribution (${source} session)`)];

  // Sort by count descending
  const sorted = Array.from(events.byType.entries()).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    lines.push('  (no events)');
    lines.push('');
    return lines.join('\n');
  }
  // Find longest label for alignment
  const maxLabel = Math.max(...sorted.map(([k]) => k.length));

  for (const [type, count] of sorted) {
    const frac = count / events.total;
    const pct = (frac * 100).toFixed(1);
    lines.push(
      `  ${bar(frac)}  ${pad(type + ':', maxLabel + 1)} ${rpad(count, 6)}  (${rpad(pct, 5)}%)`,
    );
  }

  lines.push(`  ${' '.repeat(30)}  ${pad('TOTAL:', maxLabel + 1)} ${rpad(events.total, 6)}`);
  lines.push('');
  return lines.join('\n');
}

function renderContentBlocks(blocks: ContentBlockCounts): string {
  const lines: string[] = [chalk.cyan.bold('📊 Content Blocks (from messages)')];

  const sorted = Array.from(blocks.byType.entries()).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    lines.push('  (no blocks)');
    lines.push('');
    return lines.join('\n');
  }
  const maxLabel = Math.max(...sorted.map(([k]) => k.length));

  for (const [type, count] of sorted) {
    lines.push(`  ${pad(type + ':', maxLabel + 1)} ${rpad(count, 6)}`);
  }

  lines.push(`  ${pad('TOTAL:', maxLabel + 1)} ${rpad(blocks.total, 6)}`);
  lines.push('');
  return lines.join('\n');
}

function renderToolCategories(tools: ToolCategoryCounts): string {
  const lines: string[] = [chalk.cyan.bold('🔧 Tool Calls by Category')];

  const sorted = Array.from(tools.byType.entries()).sort((a, b) => b[1] - a[1]);
  const maxLabel = Math.max(...sorted.map(([k]) => k.length), 5);
  const maxCount = Math.max(...sorted.map(([, v]) => v), 1);

  for (const [category, count] of sorted) {
    const barWidth = Math.max(1, Math.round((count / maxCount) * 20));
    lines.push(
      `  ${pad(category + ':', maxLabel + 1)} ${rpad(count, 5)}  ${'█'.repeat(barWidth)}`,
    );
  }

  lines.push(`  ${pad('TOTAL:', maxLabel + 1)} ${rpad(tools.total, 5)}`);
  lines.push('');
  return lines.join('\n');
}

function renderSubagentAnalysis(subagents: SubagentFileInfo[]): string {
  if (subagents.length === 0) return '';

  const lines: string[] = [
    chalk.cyan.bold(`🔍 Subagent Analysis (${subagents.length} found)`),
  ];
  lines.push(
    `  ${pad('Name', 30)} ${pad('Status', 12)} ${rpad('Tools', 5)}  ${rpad('Lines', 5)}`,
  );

  for (const s of subagents) {
    const statusColored =
      s.status === 'completed' ? chalk.green(pad(s.status, 12)) : chalk.red(pad(s.status, 12));
    const shortName = s.name.replace(/\.jsonl$/, '');
    lines.push(
      `  ${pad(shortName, 30)} ${statusColored} ${rpad(s.toolCallCount, 5)}  ${rpad(s.lines, 5)}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function renderReasoningChain(steps: ReasoningStep[]): string {
  if (!steps || steps.length === 0) return '';

  const lines: string[] = [
    chalk.cyan.bold(`🧠 Reasoning Chain (${steps.length} steps extracted)`),
  ];

  for (const step of steps) {
    const thought = step.thought.length > 60 ? step.thought.slice(0, 57) + '...' : step.thought;
    const next = step.nextAction
      ? step.nextAction.length > 30
        ? step.nextAction.slice(0, 27) + '...'
        : step.nextAction
      : '';
    lines.push(
      `  Step ${step.stepNumber}/${step.totalSteps} (${step.purpose}):  "${thought}"${next ? ` → Next: "${next}"` : ''}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function renderMarkdownOutput(stats: MarkdownStats, presetName: string): string {
  const lines: string[] = [
    chalk.cyan.bold(`📝 Markdown Output (preset: ${presetName})`),
    `  ┌─────────────────────┬─────────┐`,
    `  │ Total chars          │ ${rpad(stats.totalChars.toLocaleString(), 7)} │`,
    `  │ Sections             │ ${rpad(stats.sections, 7)} │`,
    `  │ Recent messages      │ ${rpad(stats.recentMessages, 7)} │`,
    `  │ Tool summaries       │ ${rpad(stats.toolSummaries, 7)} │`,
    `  │ Subagent results     │ ${rpad(stats.subagentResults, 7)} │`,
    `  │ Reasoning steps      │ ${rpad(stats.reasoningSteps, 7)} │`,
    `  │ Pending tasks        │ ${rpad(stats.pendingTasks, 7)} │`,
    `  │ Files modified       │ ${rpad(stats.filesModified, 7)} │`,
    `  └─────────────────────┴─────────┘`,
    '',
  ];
  return lines.join('\n');
}

function renderConversionSummary(
  mainSize: number,
  subagentFiles: SubagentFileInfo[],
  toolResultFiles: ToolResultFileInfo[],
  events: RawEventCounts,
  markdownStats: MarkdownStats,
  context: SessionContext,
): string {
  // Total raw input size (main JSONL + tool result files)
  const toolResultTotalSize = toolResultFiles.reduce((s, f) => s + f.size, 0);
  const rawInput = mainSize + toolResultTotalSize;

  const markdownBytes = Buffer.byteLength(context.markdown, 'utf8');
  const ratio = rawInput > 0 ? ((markdownBytes / rawInput) * 100).toFixed(1) : '0.0';

  // Count content events (non-progress)
  const contentEvents =
    (events.byType.get('assistant') || 0) + (events.byType.get('user') || 0);

  const subagentsCaptured = context.sessionNotes?.subagentResults?.length || 0;
  const reasoningCaptured = context.sessionNotes?.reasoningSteps?.length || 0;

  const lines: string[] = [
    chalk.cyan.bold('📈 Conversion Summary'),
    `  Raw input:    ${formatBytes(rawInput)} (main${subagentFiles.length > 0 ? ` + ${subagentFiles.length} subagents` : ''}${toolResultFiles.length > 0 ? ` + ${toolResultFiles.length} tool-results` : ''})`,
    `  Markdown:     ${formatBytes(markdownBytes)}`,
    `  Ratio:        ${ratio}%`,
    `  Coverage:`,
    `    ${chalk.green('✓')} ${contentEvents}/${events.total} events → content (noise filtered)`,
  ];

  if (subagentFiles.length > 0) {
    lines.push(`    ${chalk.green('✓')} ${subagentsCaptured}/${subagentFiles.length} subagent results captured`);
  }
  if (toolResultFiles.length > 0) {
    const toolResultsCaptured = context.sessionNotes?.externalToolResults?.length || 0;
    lines.push(`    ${chalk.green('✓')} ${toolResultsCaptured}/${toolResultFiles.length} tool-result files noted`);
  }
  if (reasoningCaptured > 0) {
    lines.push(`    ${chalk.green('✓')} ${reasoningCaptured} reasoning steps extracted`);
  }
  lines.push(`    ${chalk.green('✓')} ${markdownStats.recentMessages} recent messages included`);

  lines.push('');
  return lines.join('\n');
}

// ── Truncated Output ────────────────────────────────────────────────────────

function truncateLine(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

function renderTruncated(
  session: UnifiedSession,
  mainLines: number,
  mainSize: number,
  subagentFiles: SubagentFileInfo[],
  toolResultFiles: ToolResultFileInfo[],
  events: RawEventCounts,
  blocks: ContentBlockCounts,
  tools: ToolCategoryCounts,
  markdownStats: MarkdownStats,
  context: SessionContext,
  model: string | undefined,
  maxLen: number,
): string {
  const lines: string[] = [];

  // SESSION line
  const sessionLine = `SESSION: ${session.id.slice(0, 8)} | ${model || session.source} | ${mainLines} lines | ${formatBytes(mainSize)} | ${subagentFiles.length} subagents | ${toolResultFiles.length} tool-results`;
  lines.push(truncateLine(sessionLine, maxLen));

  // EVENTS line
  const eventParts = Array.from(events.byType.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  lines.push(truncateLine(`EVENTS:  ${eventParts.join(' ')}`, maxLen));

  // BLOCKS line
  const blockParts = Array.from(blocks.byType.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  lines.push(truncateLine(`BLOCKS:  ${blockParts.join(' ')}`, maxLen));

  // TOOLS line
  const toolParts = Array.from(tools.byType.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  toolParts.push(`total=${tools.total}`);
  lines.push(truncateLine(`TOOLS:   ${toolParts.join(' ')}`, maxLen));

  // SUBS line
  if (subagentFiles.length > 0) {
    const subParts = subagentFiles.map((s) => {
      const short = s.name.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      return `${short}=${s.status}(${s.toolCallCount}t,${s.lines}L)`;
    });
    lines.push(truncateLine(`SUBS:    ${subParts.join(' ')}`, maxLen));
  }

  // REASON line
  const steps = context.sessionNotes?.reasoningSteps;
  if (steps && steps.length > 0) {
    const stepParts = steps.map(
      (s) => `step${s.stepNumber}/${s.totalSteps}(${s.purpose}→${(s.nextAction || '').slice(0, 15)})`,
    );
    lines.push(truncateLine(`REASON:  ${stepParts.join(' ')}`, maxLen));
  }

  // OUTPUT line
  lines.push(
    truncateLine(
      `OUTPUT:  ${markdownStats.totalChars} chars | ${markdownStats.sections} sections | ${markdownStats.recentMessages} msgs | ${markdownStats.toolSummaries} tools | ${markdownStats.subagentResults} subs | ${markdownStats.reasoningSteps} reason | ${markdownStats.pendingTasks} pending | ${markdownStats.filesModified} files`,
      maxLen,
    ),
  );

  // RATIO line
  const markdownBytes = Buffer.byteLength(context.markdown, 'utf8');
  const rawInput = mainSize + toolResultFiles.reduce((s, f) => s + f.size, 0);
  const ratio = rawInput > 0 ? ((markdownBytes / rawInput) * 100).toFixed(1) : '0.0';
  const contentEvents = (events.byType.get('assistant') || 0) + (events.byType.get('user') || 0);
  const subsCaptured = context.sessionNotes?.subagentResults?.length || 0;
  const toolResCaptured = context.sessionNotes?.externalToolResults?.length || 0;
  const reasonCaptured = context.sessionNotes?.reasoningSteps?.length || 0;

  lines.push(
    truncateLine(
      `RATIO:   ${formatBytes(rawInput)} → ${formatBytes(markdownBytes)} (${ratio}%) | events=${contentEvents}/${events.total} | subs=${subsCaptured}/${subagentFiles.length} | toolres=${toolResCaptured}/${toolResultFiles.length} | reason=${reasonCaptured}`,
      maxLen,
    ),
  );

  return lines.join('\n');
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Inspect a session and display detailed parsing diagnostics.
 *
 * @param sessionIdOrShort - Full or short session ID
 * @param opts.preset - Verbosity preset name (default: 'standard')
 * @param opts.truncate - If set, output compact one-liner per section truncated to N chars
 * @param opts.writeMd - If set, write markdown output to file (true = auto-name, string = path)
 */
export async function inspectSession(
  sessionIdOrShort: string,
  opts: { preset?: string; truncate?: number; writeMd?: string | boolean; chain?: boolean },
): Promise<void> {
  // 1. Find session
  const session = await findSession(sessionIdOrShort);
  if (!session) {
    console.error(chalk.red(`Session not found: ${sessionIdOrShort}`));
    process.exitCode = 1;
    return;
  }

  const presetName = opts.preset || 'standard';
  let config: VerbosityConfig;
  try {
    config = getPreset(presetName);
  } catch {
    // Fall back to loaded config if preset name is invalid
    config = loadConfig();
  }

  if (opts.chain === false) {
    config = {
      ...config,
      agents: {
        ...config.agents,
        claude: {
          ...config.agents.claude,
          chainCompactedHistory: false,
        },
      },
    };
  }

  // 2. Read raw events (format-aware)
  const format = getSessionFormat(session.source);
  let rawMessages: Array<Record<string, unknown>> = [];
  let rawEventNote = '';

  if (format === 'jsonl') {
    rawMessages = await readJsonlFile<Record<string, unknown>>(session.originalPath);
  } else if (format === 'json') {
    try {
      const content = fs.readFileSync(session.originalPath, 'utf-8');
      const parsed = JSON.parse(content);
      rawMessages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      rawEventNote = '(JSON parse failed)';
    }
  } else if (format === 'sqlite') {
    rawEventNote = '(raw event analysis not available for SQLite sessions)';
  } else if (format === 'yaml') {
    rawEventNote = '(raw event analysis not available for YAML sessions)';
  }

  const { events, blocks, tools, model } = analyzeRawMessages(rawMessages);

  // 3. File stats
  const mainFileStats = fs.statSync(session.originalPath);
  const mainSize = mainFileStats.size;
  const mainLines = format === 'jsonl' ? rawMessages.length : countLines(session.originalPath);

  // 4. Subagent & tool-result files (Claude-specific)
  const sessionDir = session.originalPath.replace(/\.jsonl$/, '');
  let subagentFiles: SubagentFileInfo[] = [];
  let toolResultFiles: ToolResultFileInfo[] = [];

  if (session.source === 'claude') {
    subagentFiles = await analyzeSubagentFiles(sessionDir);

    const toolResultsDir = path.join(sessionDir, 'tool-results');
    toolResultFiles = listDir(toolResultsDir).map((f) => ({
      name: f.name,
      lines: f.lines,
      size: f.size,
    }));
  }

  // 5. Run extraction pipeline via adapter
  const adapter = adapters[session.source];
  const context = await adapter.extractContext(session, config);
  const markdownStats = computeMarkdownStats(context);

  // 6. Write markdown if requested
  if (opts.writeMd !== undefined && opts.writeMd !== false) {
    const mdPath =
      typeof opts.writeMd === 'string'
        ? opts.writeMd
        : `inspect-${session.id.slice(0, 8)}.md`;
    fs.writeFileSync(mdPath, context.markdown, 'utf8');
    console.log(chalk.green(`Markdown written to ${mdPath}`));
  }

  // 7. Render output
  if (opts.truncate) {
    console.log(
      renderTruncated(
        session,
        mainLines,
        mainSize,
        subagentFiles,
        toolResultFiles,
        events,
        blocks,
        tools,
        markdownStats,
        context,
        model,
        opts.truncate,
      ),
    );
    if (rawMessages.length === 0 && rawEventNote) {
      console.log(chalk.gray(`  ${rawEventNote}`));
    }
    return;
  }

  // Full output
  const output: string[] = [];

  output.push(renderHeader(session.id));
  output.push(
    renderSourceFiles(session, mainLines, mainSize, subagentFiles, toolResultFiles),
  );
  output.push(renderEventDistribution(events, session.source));
  if (rawMessages.length === 0 && rawEventNote) {
    output.push(chalk.gray(`  ${rawEventNote}\n`));
  }

  if (blocks.total > 0) {
    output.push(renderContentBlocks(blocks));
  }

  if (tools.total > 0) {
    output.push(renderToolCategories(tools));
  }

  if (subagentFiles.length > 0) {
    output.push(renderSubagentAnalysis(subagentFiles));
  }

  if (context.sessionNotes?.reasoningSteps) {
    output.push(renderReasoningChain(context.sessionNotes.reasoningSteps));
  }

  output.push(renderMarkdownOutput(markdownStats, presetName));
  output.push(
    renderConversionSummary(
      mainSize,
      subagentFiles,
      toolResultFiles,
      events,
      markdownStats,
      context,
    ),
  );

  console.log(output.join('\n'));
}

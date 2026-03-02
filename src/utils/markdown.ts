import { adapters } from '../parsers/registry.js';
import * as os from 'os';
import type {
  ConversationMessage,
  SessionNotes,
  SubagentResult,
  ReasoningStep,
  StructuredToolSample,
  ToolSample,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import {
  SHELL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  EDIT_TOOLS,
  GREP_TOOLS,
  GLOB_TOOLS,
  SEARCH_TOOLS,
  FETCH_TOOLS,
  TASK_TOOLS,
  TASK_OUTPUT_TOOLS,
  ASK_TOOLS,
  classifyToolName,
} from '../types/tool-names.js';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';

/** Replace home directory prefix with ~ and escape backticks for safe markdown inline code */
const _home = os.homedir();
export function safePath(p: string): string {
  const tildified = p.startsWith(_home) ? '~' + p.slice(_home.length) : p;
  return tildified.replace(/`/g, '\\`');
}

/** Human-readable labels for each session source — derived lazily from the adapter registry */
let _sourceLabels: Record<string, string> | null = null;
export function getSourceLabels(): Record<string, string> {
  if (!_sourceLabels) {
    _sourceLabels = Object.fromEntries(Object.values(adapters).map((a) => [a.name, a.label]));
  }
  return _sourceLabels;
}

// ── Display Caps ────────────────────────────────────────────────────────────

interface DisplayCaps {
  shellDetailed: number;
  shellStdoutLines: number;
  writeEditDetailed: number;
  writeEditDiffLines: number;
  readEntries: number;
  grepGlobSearchFetch: number;
  mcpTaskAsk: number;
}

/** Derive display caps from a VerbosityConfig — single source of truth for all limits */
function capsFromConfig(config: VerbosityConfig): DisplayCaps {
  return {
    shellDetailed: config.shell.maxSamples,
    shellStdoutLines: config.shell.stdoutLines,
    writeEditDetailed: config.write.maxSamples,
    writeEditDiffLines: config.write.diffLines,
    readEntries: config.read.maxSamples,
    grepGlobSearchFetch: config.grep.maxSamples,
    mcpTaskAsk: config.mcp.maxSamplesPerNamespace,
  };
}

// ── Category Ordering ───────────────────────────────────────────────────────

/** Build sort-order map from the canonical tool name sets — never goes stale */
function buildCategoryOrder(): Record<string, number> {
  const order: Record<string, number> = {};
  const mapping: [ReadonlySet<string>, number][] = [
    [SHELL_TOOLS, 0],
    [WRITE_TOOLS, 1],
    [EDIT_TOOLS, 2],
    [READ_TOOLS, 3],
    [GREP_TOOLS, 4],
    [GLOB_TOOLS, 5],
    [SEARCH_TOOLS, 6],
    [FETCH_TOOLS, 7],
    [TASK_TOOLS, 8],
    [TASK_OUTPUT_TOOLS, 8],
    [ASK_TOOLS, 9],
  ];
  for (const [set, priority] of mapping) {
    for (const name of set) order[name] = priority;
  }
  return order;
}

const CATEGORY_ORDER: Record<string, number> = buildCategoryOrder();

function getCategoryOrder(name: string): number {
  return CATEGORY_ORDER[name] ?? 10; // MCP/unknown go last
}

/**
 * Generate a markdown handoff document from any session source.
 * Shared by all parsers to avoid duplicated logic.
 */
export function generateHandoffMarkdown(
  session: UnifiedSession,
  messages: ConversationMessage[],
  filesModified: string[],
  pendingTasks: string[],
  toolSummaries: ToolUsageSummary[] = [],
  sessionNotes?: SessionNotes,
  config: VerbosityConfig = getPreset('standard'),
  mode: 'inline' | 'reference' = 'inline',
): string {
  const labels = getSourceLabels();
  const sourceLabel = labels[session.source] || session.source;
  const caps = capsFromConfig(config);

  const lines: string[] = [
    '# Session Handoff Context',
    '',
    '',
    '## Session Overview',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| **Source** | ${sourceLabel} |`,
    `| **Session ID** | \`${session.id}\` |`,
    `| **Working Directory** | \`${session.cwd}\` |`,
  ];

  if (session.originalPath) {
    lines.push(`| **Session File** | \`${safePath(session.originalPath)}\` |`);
  }

  if (session.repo) {
    lines.push(`| **Repository** | ${session.repo}${session.branch ? ` @ \`${session.branch}\`` : ''} |`);
  }
  if (session.model) {
    lines.push(`| **Model** | ${session.model} |`);
  }
  if (sessionNotes?.model && sessionNotes.model !== session.model) {
    lines.push(`| **Model** | ${sessionNotes.model} |`);
  }
  lines.push(`| **Last Active** | ${session.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} |`);
  if (sessionNotes?.tokenUsage && (sessionNotes.tokenUsage.input > 0 || sessionNotes.tokenUsage.output > 0)) {
    lines.push(
      `| **Tokens Used** | ${sessionNotes.tokenUsage.input.toLocaleString()} in / ${sessionNotes.tokenUsage.output.toLocaleString()} out |`,
    );
  }
  if (sessionNotes?.cacheTokens && (sessionNotes.cacheTokens.read > 0 || sessionNotes.cacheTokens.creation > 0)) {
    lines.push(
      `| **Cache Tokens** | ${sessionNotes.cacheTokens.read.toLocaleString()} read / ${sessionNotes.cacheTokens.creation.toLocaleString()} created |`,
    );
  }
  if (sessionNotes?.thinkingTokens && sessionNotes.thinkingTokens > 0) {
    lines.push(`| **Thinking Tokens** | ${sessionNotes.thinkingTokens.toLocaleString()} |`);
  }
  if (sessionNotes?.activeTimeMs) {
    const mins = Math.round(sessionNotes.activeTimeMs / 60000);
    lines.push(`| **Active Time** | ${mins} min |`);
  }
  lines.push(`| **Files Modified** | ${filesModified.length} |`);
  lines.push(`| **Messages** | ${messages.length} |`);
  lines.push('');
  lines.push('');

  if (session.summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(`> ${session.summary}`);
    lines.push('');
    lines.push('');
  }

  if (sessionNotes?.compactSummary) {
    lines.push('## Session Context (Compacted)');
    lines.push('');
    lines.push(`> ${sessionNotes.compactSummary}`);
    lines.push('');
    lines.push('');
  }

  // ── Category-aware Tool Activity section ──
  if (toolSummaries.length > 0) {
    lines.push('## Tool Activity');
    lines.push('');
    lines.push(...renderToolActivity(toolSummaries, caps));
    lines.push('');
  }

  // ── Subagent Results ──
  if (sessionNotes?.subagentResults && sessionNotes.subagentResults.length > 0) {
    lines.push(...renderSubagentResults(sessionNotes.subagentResults, config));
  }

  if (sessionNotes?.reasoning && sessionNotes.reasoning.length > 0) {
    lines.push('## Key Decisions');
    lines.push('');
    for (const thought of sessionNotes.reasoning.slice(0, config.thinking.maxHighlights)) {
      lines.push(`- ${thought}`);
    }
    lines.push('');
    lines.push('');
  }

  // ── Reasoning Chain ──
  if (sessionNotes?.reasoningSteps && sessionNotes.reasoningSteps.length > 0) {
    lines.push(...renderReasoningChain(sessionNotes.reasoningSteps));
  }

  // Show recent messages for richer context
  const recentMessages = messages.slice(-config.recentMessages);
  if (recentMessages.length > 0) {
    lines.push('## Recent Conversation');
    lines.push('');
    for (const msg of recentMessages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`### ${role}`);
      lines.push('');
      const maxChars = config.maxMessageChars;
      lines.push(msg.content.slice(0, maxChars) + (msg.content.length > maxChars ? '\u2026' : ''));
      lines.push('');
    }
    lines.push('');
  }

  if (filesModified.length > 0) {
    lines.push('## Files Modified');
    lines.push('');
    for (const file of filesModified) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
    lines.push('');
  }

  if (pendingTasks.length > 0) {
    lines.push('## Pending Tasks');
    lines.push('');
    for (const task of pendingTasks) {
      lines.push(`- [ ] ${task}`);
    }
    lines.push('');
    lines.push('');
  }

  if (session.originalPath) {
    lines.push('## Session Origin');
    lines.push('');
    lines.push(`This session was extracted from **${labels[session.source] || session.source}** session data.`);
    lines.push(`- **Session file**: \`${safePath(session.originalPath)}\``);
    lines.push(`- **Session ID**: \`${session.id}\``);
    if (session.cwd) {
      lines.push(`- **Project directory**: \`${session.cwd}\``);
    }
    lines.push('');
    lines.push('> To access the raw session data, inspect the file path above.');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    '**You are continuing this session. Pick up exactly where it left off — review the conversation above, check pending tasks, and keep going.**',
  );

  return lines.join('\n');
}

// ── MCP Namespace Grouping ───────────────────────────────────────────────────

/**
 * Group MCP tools sharing a `mcp__<namespace>__*` prefix into a single
 * synthetic ToolUsageSummary. Non-namespaced tools pass through unchanged.
 */
function groupMcpByNamespace(summaries: ToolUsageSummary[], mcpSampleCap: number): ToolUsageSummary[] {
  const result: ToolUsageSummary[] = [];
  const nsGroups = new Map<string, ToolUsageSummary[]>();

  for (const tool of summaries) {
    const category = detectCategory(tool);
    if (category !== 'mcp' || !tool.name.startsWith('mcp__')) {
      result.push(tool);
      continue;
    }
    // Extract namespace: mcp__github__list_issues → github
    const parts = tool.name.split('__');
    if (parts.length < 3) {
      result.push(tool);
      continue;
    }
    const ns = parts[1];
    if (!nsGroups.has(ns)) nsGroups.set(ns, []);
    nsGroups.get(ns)!.push(tool);
  }

  // Merge groups with 2+ tools; leave singletons ungrouped
  for (const [ns, tools] of nsGroups) {
    if (tools.length === 1) {
      result.push(tools[0]);
      continue;
    }
    const totalCount = tools.reduce((s, t) => s + t.count, 0);
    const totalErrors = tools.reduce((s, t) => s + (t.errorCount || 0), 0);
    const mergedSamples: ToolSample[] = [];
    for (const t of tools) {
      for (const s of t.samples) {
        if (mergedSamples.length < mcpSampleCap) mergedSamples.push(s);
      }
    }
    result.push({
      name: `MCP: ${ns}`,
      count: totalCount,
      ...(totalErrors > 0 ? { errorCount: totalErrors } : {}),
      samples: mergedSamples,
    });
  }

  return result;
}

// ── Category-Aware Rendering ────────────────────────────────────────────────

function renderToolActivity(toolSummaries: ToolUsageSummary[], caps: DisplayCaps): string[] {
  // Group MCP tools by namespace (e.g. mcp__github__* → "MCP: github")
  const grouped = groupMcpByNamespace(toolSummaries, caps.mcpTaskAsk);
  const sorted = [...grouped].sort((a, b) => getCategoryOrder(a.name) - getCategoryOrder(b.name));
  const lines: string[] = [];

  for (const tool of sorted) {
    const category = detectCategory(tool);
    switch (category) {
      case 'shell':
        lines.push(...renderShellSection(tool, caps));
        break;
      case 'write':
        lines.push(...renderWriteSection(tool, caps));
        break;
      case 'edit':
        lines.push(...renderEditSection(tool, caps));
        break;
      case 'read':
        lines.push(...renderReadSection(tool, caps));
        break;
      case 'grep':
        lines.push(...renderGrepSection(tool, caps));
        break;
      case 'glob':
        lines.push(...renderGlobSection(tool, caps));
        break;
      case 'search':
      case 'fetch':
      case 'task':
      case 'ask':
      case 'mcp':
        lines.push(...renderCompactSection(tool, category, caps));
        break;
      default:
        lines.push(...renderFallbackSection(tool));
    }
    lines.push('');
  }

  return lines;
}

/** Detect the structural category of a ToolUsageSummary from its first sample's data */
function detectCategory(tool: ToolUsageSummary): string {
  const firstData = tool.samples[0]?.data;
  if (firstData) return firstData.category;
  // Fallback: use canonical classifier from tool-names.ts (never goes stale)
  return classifyToolName(tool.name) || 'mcp';
}

// ── Shell Renderer ──────────────────────────────────────────────────────────

function renderShellSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const errorStr = tool.errorCount ? `, ${tool.errorCount} errors` : '';
  const lines: string[] = [`### Shell (${tool.count} calls${errorStr})`, ''];

  const detailed = tool.samples.slice(0, caps.shellDetailed);
  for (const sample of detailed) {
    lines.push(...renderShellSample(sample, caps.shellStdoutLines));
  }

  const remaining = tool.count - detailed.length;
  if (remaining > 0) {
    const allOk = !tool.errorCount ? ' (all exit 0)' : '';
    lines.push(`*...and ${remaining} more shell calls${allOk}*`);
    lines.push('');
  }

  return lines;
}

function renderShellSample(sample: ToolSample, maxStdoutLines: number): string[] {
  const d = sample.data;
  if (!d || d.category !== 'shell') {
    return [`> \`${sample.summary}\``, ''];
  }

  const lines: string[] = [`> \`$ ${d.command}\``];

  if (d.exitCode !== undefined) {
    const errorTag = d.errored ? '  **[ERROR]**' : '';
    lines.push(`> Exit: ${d.exitCode}${errorTag}`);
  }

  if (d.stdoutTail) {
    const tailLines = d.stdoutTail.split('\n').slice(0, maxStdoutLines);
    lines.push('> ```');
    for (const tl of tailLines) {
      lines.push(`> ${tl}`);
    }
    lines.push('> ```');
  } else if (d.errored && d.errorMessage) {
    const errLines = d.errorMessage.split('\n').slice(0, maxStdoutLines);
    lines.push('> ```');
    for (const el of errLines) {
      lines.push(`> ${el}`);
    }
    lines.push('> ```');
  }

  lines.push('');
  return lines;
}

// ── Write Renderer ──────────────────────────────────────────────────────────

function renderWriteSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const errorStr = tool.errorCount ? `, ${tool.errorCount} errors` : '';
  const lines: string[] = [`### Write (${tool.count} calls${errorStr})`, ''];

  const detailed = tool.samples.slice(0, caps.writeEditDetailed);
  const overflow: string[] = [];

  for (const sample of detailed) {
    lines.push(...renderWriteSample(sample, caps.writeEditDiffLines));
  }

  // Overflow: list remaining files
  for (const sample of tool.samples.slice(caps.writeEditDetailed)) {
    const d = sample.data;
    if (d && d.category === 'write') {
      const stats = d.diffStats ? ` (+${d.diffStats.added} -${d.diffStats.removed})` : '';
      overflow.push(`\`${d.filePath}\`${stats}`);
    }
  }

  const remaining = tool.count - detailed.length;
  if (remaining > 0) {
    const fileList = overflow.length > 0 ? `: ${overflow.join(', ')}` : '';
    lines.push(`*...and ${remaining} more writes${fileList}*`);
    lines.push('');
  }

  return lines;
}

function renderWriteSample(sample: ToolSample, maxDiffLines: number): string[] {
  const d = sample.data;
  if (!d || d.category !== 'write') {
    return [`> \`${sample.summary}\``, ''];
  }

  const newTag = d.isNewFile ? ' (new file)' : '';
  const statsTag = d.diffStats ? ` (+${d.diffStats.added} lines)` : '';
  const lines: string[] = [`> **\`${d.filePath}\`**${newTag}${statsTag}`];

  if (d.diff) {
    const diffLines = d.diff.split('\n');
    // Skip the header lines (--- and +++)
    const bodyLines = diffLines.filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
    const capped = bodyLines.slice(0, maxDiffLines);

    lines.push('> ```diff');
    for (const dl of capped) {
      lines.push(`> ${dl}`);
    }
    lines.push('> ```');

    const truncated = bodyLines.length - capped.length;
    if (truncated > 0) {
      lines.push(`> *+${truncated} lines truncated*`);
    }
  }

  if (d.errorMessage) {
    const errLines = d.errorMessage.split('\n').slice(0, 3);
    lines.push('> **Error:**');
    lines.push('> ```');
    for (const el of errLines) lines.push(`> ${el}`);
    lines.push('> ```');
  }

  lines.push('');
  return lines;
}

// ── Edit Renderer ───────────────────────────────────────────────────────────

function renderEditSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const errorStr = tool.errorCount ? `, ${tool.errorCount} errors` : '';
  const lines: string[] = [`### Edit (${tool.count} calls${errorStr})`, ''];

  const detailed = tool.samples.slice(0, caps.writeEditDetailed);
  const overflow: string[] = [];

  for (const sample of detailed) {
    lines.push(...renderEditSample(sample, caps.writeEditDiffLines));
  }

  for (const sample of tool.samples.slice(caps.writeEditDetailed)) {
    const d = sample.data;
    if (d && d.category === 'edit') {
      const stats = d.diffStats ? ` (+${d.diffStats.added} -${d.diffStats.removed})` : '';
      overflow.push(`\`${d.filePath}\`${stats}`);
    }
  }

  const remaining = tool.count - detailed.length;
  if (remaining > 0) {
    const fileList = overflow.length > 0 ? `: ${overflow.join(', ')}` : '';
    lines.push(`*...and ${remaining} more edits${fileList}*`);
    lines.push('');
  }

  return lines;
}

function renderEditSample(sample: ToolSample, maxDiffLines: number): string[] {
  const d = sample.data;
  if (!d || d.category !== 'edit') {
    return [`> \`${sample.summary}\``, ''];
  }

  const statsTag = d.diffStats ? ` (+${d.diffStats.added} -${d.diffStats.removed} lines)` : '';
  const lines: string[] = [`> **\`${d.filePath}\`**${statsTag}`];

  if (d.diff) {
    const diffLines = d.diff.split('\n');
    const bodyLines = diffLines.filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
    const capped = bodyLines.slice(0, maxDiffLines);

    lines.push('> ```diff');
    for (const dl of capped) {
      lines.push(`> ${dl}`);
    }
    lines.push('> ```');

    const truncated = bodyLines.length - capped.length;
    if (truncated > 0) {
      lines.push(`> *+${truncated} lines truncated*`);
    }
  }

  if (d.errorMessage) {
    const errLines = d.errorMessage.split('\n').slice(0, 3);
    lines.push('> **Error:**');
    lines.push('> ```');
    for (const el of errLines) lines.push(`> ${el}`);
    lines.push('> ```');
  }

  lines.push('');
  return lines;
}

// ── Read Renderer ───────────────────────────────────────────────────────────

function renderReadSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const errorStr = tool.errorCount ? `, ${tool.errorCount} errors` : '';
  const lines: string[] = [`### Read (${tool.count} calls${errorStr})`, ''];

  const shown = tool.samples.slice(0, caps.readEntries);
  for (const sample of shown) {
    const d = sample.data;
    if (d && d.category === 'read') {
      const range =
        d.lineStart && d.lineEnd
          ? ` (lines ${d.lineStart}-${d.lineEnd})`
          : d.lineStart
            ? ` (from line ${d.lineStart})`
            : '';
      lines.push(`- \`${d.filePath}\`${range}`);
    } else {
      lines.push(`- \`${sample.summary}\``);
    }
  }

  const remaining = tool.count - shown.length;
  if (remaining > 0) {
    lines.push(`- *...and ${remaining} more files read*`);
  }

  lines.push('');
  return lines;
}

// ── Grep Renderer ───────────────────────────────────────────────────────────

function renderGrepSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const errorStr = tool.errorCount ? `, ${tool.errorCount} errors` : '';
  const lines: string[] = [`### Grep (${tool.count} calls${errorStr})`, ''];

  const shown = tool.samples.slice(0, caps.grepGlobSearchFetch);
  for (const sample of shown) {
    const d = sample.data;
    if (d && d.category === 'grep') {
      const path = d.targetPath ? ` in \`${d.targetPath}\`` : '';
      const count = d.matchCount !== undefined ? ` — ${d.matchCount} matches` : '';
      lines.push(`- \`"${d.pattern}"\`${path}${count}`);
    } else {
      lines.push(`- \`${sample.summary}\``);
    }
  }

  const remaining = tool.count - shown.length;
  if (remaining > 0) lines.push(`- *...and ${remaining} more grep searches*`);
  lines.push('');
  return lines;
}

// ── Glob Renderer ───────────────────────────────────────────────────────────

function renderGlobSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const errorStr = tool.errorCount ? `, ${tool.errorCount} errors` : '';
  const lines: string[] = [`### Glob (${tool.count} calls${errorStr})`, ''];

  const shown = tool.samples.slice(0, caps.grepGlobSearchFetch);
  for (const sample of shown) {
    const d = sample.data;
    if (d && d.category === 'glob') {
      const count = d.resultCount !== undefined ? ` — ${d.resultCount} files` : '';
      lines.push(`- \`${d.pattern}\`${count}`);
    } else {
      lines.push(`- \`${sample.summary}\``);
    }
  }

  const remaining = tool.count - shown.length;
  if (remaining > 0) lines.push(`- *...and ${remaining} more glob calls*`);
  lines.push('');
  return lines;
}

// ── Compact Renderer (Search, Fetch, Task, Ask, MCP) ────────────────────────

function renderCompactSection(
  tool: ToolUsageSummary,
  category: string,
  caps: DisplayCaps,
): string[] {
  const label = COMPACT_LABELS[category] || tool.name;
  const errorStr = tool.errorCount ? `, ${tool.errorCount} errors` : '';
  const lines: string[] = [`### ${label} (${tool.count} calls${errorStr})`, ''];
  const cap = ['search', 'fetch'].includes(category) ? caps.grepGlobSearchFetch : caps.mcpTaskAsk;

  const shown = tool.samples.slice(0, cap);
  for (const sample of shown) {
    lines.push(`- ${formatCompactSample(sample, category)}`);
  }

  const remaining = tool.count - shown.length;
  if (remaining > 0) lines.push(`- *...and ${remaining} more*`);
  lines.push('');
  return lines;
}

const COMPACT_LABELS: Record<string, string> = {
  search: 'Search',
  fetch: 'Fetch',
  task: 'Task',
  ask: 'Ask',
  mcp: 'MCP',
};

function formatCompactSample(sample: ToolSample, category: string): string {
  const d = sample.data;
  if (!d) return `\`${sample.summary}\``;

  switch (d.category) {
    case 'search': {
      const countStr = d.resultCount !== undefined ? ` — ${d.resultCount} results` : '';
      const preview = d.resultPreview ? ` "${d.resultPreview.slice(0, 60)}..."` : '';
      return `"${d.query}"${countStr}${preview}`;
    }
    case 'fetch': {
      const preview = d.resultPreview ? ` — "${d.resultPreview}..."` : '';
      return `\`${d.url}\`${preview}`;
    }
    case 'task': {
      const agentStr = d.agentType ? ` (type: \`${d.agentType}\`)` : '';
      const resultStr = d.resultSummary ? ` — "${d.resultSummary}"` : '';
      return `"${d.description}"${agentStr}${resultStr}`;
    }
    case 'ask':
      return `"${d.question}"`;
    case 'mcp': {
      const params = d.params ? `(${d.params})` : '';
      const resultStr = d.result ? ` — "${d.result}"` : '';
      return `\`${d.toolName}${params}\`${resultStr}`;
    }
    default:
      return `\`${sample.summary}\``;
  }
}

// ── Subagent Results Renderer ────────────────────────────────────────────────

function renderSubagentResults(results: SubagentResult[], config: VerbosityConfig): string[] {
  const lines: string[] = ['## Subagent Results', ''];

  for (const r of results) {
    lines.push(`### ${r.description} (${r.taskId})`);
    if (r.status === 'completed' && r.result) {
      const maxChars = config.task.subagentResultChars;
      const text = r.result.length > maxChars ? r.result.slice(0, maxChars) + '\u2026' : r.result;
      // Render each line as a blockquote
      for (const line of text.split('\n')) {
        lines.push(`> ${line}`);
      }
    } else {
      // Non-completed: show status
      lines.push(`> \u26a0\ufe0f ${capitalize(r.status)}`);
    }
    if (r.toolCallCount > 0) {
      lines.push(`> Tools used: ${r.toolCallCount}`);
    }
    lines.push('');
  }

  lines.push('');
  return lines;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Reasoning Chain Renderer ────────────────────────────────────────────────

function renderReasoningChain(steps: ReasoningStep[]): string[] {
  const lines: string[] = ['## Reasoning Chain', ''];

  for (const step of steps) {
    const label = `**${capitalize(step.purpose)}** (step ${step.stepNumber}/${step.totalSteps})`;
    const thought = step.thought.length > 200 ? step.thought.slice(0, 200) + '\u2026' : step.thought;
    let line = `${step.stepNumber}. ${label}: ${thought}`;
    if (step.nextAction) {
      line += `\n   \u2192 Next: ${step.nextAction}`;
    }
    lines.push(line);
  }

  lines.push('');
  lines.push('');
  return lines;
}

// ── Fallback Renderer ───────────────────────────────────────────────────────

function renderFallbackSection(tool: ToolUsageSummary): string[] {
  const lines: string[] = [`### ${tool.name} (${tool.count} calls)`, ''];
  for (const sample of tool.samples.slice(0, 5)) {
    lines.push(`- \`${sample.summary}\``);
  }
  const remaining = tool.count - Math.min(tool.samples.length, 5);
  if (remaining > 0) lines.push(`- *...and ${remaining} more*`);
  lines.push('');
  return lines;
}

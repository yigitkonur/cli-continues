import { adapters } from '../parsers/registry.js';
import type {
  ConversationMessage,
  SessionNotes,
  StructuredToolSample,
  ToolSample,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';

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

const INLINE_CAPS: DisplayCaps = {
  shellDetailed: 5,
  shellStdoutLines: 3,
  writeEditDetailed: 3,
  writeEditDiffLines: 50,
  readEntries: 15,
  grepGlobSearchFetch: 8,
  mcpTaskAsk: 3,
};

const REFERENCE_CAPS: DisplayCaps = {
  shellDetailed: 8,
  shellStdoutLines: 5,
  writeEditDetailed: 5,
  writeEditDiffLines: 200,
  readEntries: 20,
  grepGlobSearchFetch: 10,
  mcpTaskAsk: 5,
};

// ── Category Ordering ───────────────────────────────────────────────────────

/** Fixed order: most action-relevant first */
const CATEGORY_ORDER: Record<string, number> = {
  Bash: 0,
  shell: 0,
  Write: 1,
  WriteFile: 1,
  write_file: 1,
  Create: 1,
  create_file: 1,
  Edit: 2,
  EditFile: 2,
  edit_file: 2,
  apply_diff: 2,
  ApplyPatch: 2,
  Read: 3,
  ReadFile: 3,
  read_file: 3,
  Grep: 4,
  grep: 4,
  codebase_search: 4,
  Glob: 5,
  LS: 5,
  WebSearch: 6,
  web_search: 6,
  WebFetch: 7,
  web_fetch: 7,
  Task: 8,
  TaskOutput: 8,
  AskUserQuestion: 9,
};

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
  mode: 'inline' | 'reference' = 'inline',
): string {
  const labels = getSourceLabels();
  const sourceLabel = labels[session.source] || session.source;

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
  if (sessionNotes?.tokenUsage) {
    lines.push(
      `| **Tokens Used** | ${sessionNotes.tokenUsage.input.toLocaleString()} in / ${sessionNotes.tokenUsage.output.toLocaleString()} out |`,
    );
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

  // ── Category-aware Tool Activity section ──
  if (toolSummaries.length > 0) {
    const caps = mode === 'reference' ? REFERENCE_CAPS : INLINE_CAPS;
    lines.push('## Tool Activity');
    lines.push('');
    lines.push(...renderToolActivity(toolSummaries, caps));
    lines.push('');
  }

  if (sessionNotes?.reasoning && sessionNotes.reasoning.length > 0) {
    lines.push('## Key Decisions');
    lines.push('');
    for (const thought of sessionNotes.reasoning.slice(0, 5)) {
      lines.push(`- ${thought}`);
    }
    lines.push('');
    lines.push('');
  }

  // Show last 10 messages for richer context
  const recentMessages = messages.slice(-10);
  if (recentMessages.length > 0) {
    lines.push('## Recent Conversation');
    lines.push('');
    for (const msg of recentMessages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`### ${role}`);
      lines.push('');
      lines.push(msg.content.slice(0, 500) + (msg.content.length > 500 ? '\u2026' : ''));
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

  lines.push('---');
  lines.push('');
  lines.push(
    '**You are continuing this session. Pick up exactly where it left off — review the conversation above, check pending tasks, and keep going.**',
  );

  return lines.join('\n');
}

// ── Category-Aware Rendering ────────────────────────────────────────────────

function renderToolActivity(toolSummaries: ToolUsageSummary[], caps: DisplayCaps): string[] {
  const sorted = [...toolSummaries].sort((a, b) => getCategoryOrder(a.name) - getCategoryOrder(b.name));
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
  // Fallback: guess from tool name
  const name = tool.name;
  if (['Bash', 'shell'].includes(name) || name.includes('terminal') || name.includes('exec')) return 'shell';
  if (['Write', 'WriteFile', 'write_file', 'Create', 'create_file'].includes(name)) return 'write';
  if (['Edit', 'EditFile', 'edit_file', 'apply_diff', 'ApplyPatch'].includes(name)) return 'edit';
  if (['Read', 'ReadFile', 'read_file'].includes(name)) return 'read';
  if (['Grep', 'grep', 'codebase_search'].includes(name)) return 'grep';
  if (['Glob', 'glob', 'list_directory', 'file_search', 'LS'].includes(name)) return 'glob';
  if (['WebSearch', 'web_search'].includes(name)) return 'search';
  if (['WebFetch', 'web_fetch'].includes(name)) return 'fetch';
  if (['Task', 'TaskOutput'].includes(name)) return 'task';
  if (['AskUserQuestion', 'request_user_input'].includes(name)) return 'ask';
  return 'mcp';
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
  }

  lines.push('');
  return lines;
}

// ── Write Renderer ──────────────────────────────────────────────────────────

function renderWriteSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const lines: string[] = [`### Write (${tool.count} calls)`, ''];

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

  lines.push('');
  return lines;
}

// ── Edit Renderer ───────────────────────────────────────────────────────────

function renderEditSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const lines: string[] = [`### Edit (${tool.count} calls)`, ''];

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

  lines.push('');
  return lines;
}

// ── Read Renderer ───────────────────────────────────────────────────────────

function renderReadSection(tool: ToolUsageSummary, caps: DisplayCaps): string[] {
  const lines: string[] = [`### Read (${tool.count} calls)`, ''];

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
  const lines: string[] = [`### Grep (${tool.count} calls)`, ''];

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
  const lines: string[] = [`### Glob (${tool.count} calls)`, ''];

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
  const lines: string[] = [`### ${label} (${tool.count} calls)`, ''];
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
    case 'search':
      return `"${d.query}"`;
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

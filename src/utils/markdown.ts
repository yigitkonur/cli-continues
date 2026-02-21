import { adapters } from '../parsers/registry.js';
import type { ConversationMessage, SessionNotes, ToolUsageSummary, UnifiedSession } from '../types/index.js';

/** Human-readable labels for each session source — derived lazily from the adapter registry */
let _sourceLabels: Record<string, string> | null = null;
export function getSourceLabels(): Record<string, string> {
  if (!_sourceLabels) {
    _sourceLabels = Object.fromEntries(Object.values(adapters).map((a) => [a.name, a.label]));
  }
  return _sourceLabels;
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

  if (toolSummaries.length > 0) {
    lines.push('## Tool Activity');
    lines.push('');
    const sortedTools = [...toolSummaries].sort((a, b) => b.count - a.count);
    for (const tool of sortedTools) {
      const sampleStr = tool.samples.map((s) => `\`${s.summary}\``).join(' · ');
      lines.push(`- **${tool.name}** (×${tool.count}): ${sampleStr}`);
    }
    lines.push('');
    lines.push('');
  }

  if (sessionNotes?.reasoning && sessionNotes.reasoning.length > 0) {
    lines.push('## Key Decisions');
    lines.push('');
    for (const thought of sessionNotes.reasoning.slice(0, 5)) {
      lines.push(`- 💭 ${thought}`);
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
      const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
      lines.push(`### ${role}`);
      lines.push('');
      lines.push(msg.content.slice(0, 500) + (msg.content.length > 500 ? '…' : ''));
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

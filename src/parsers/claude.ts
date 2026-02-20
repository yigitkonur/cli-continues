import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { UnifiedSession, SessionContext, ConversationMessage, ToolUsageSummary, SessionNotes } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { SummaryCollector, shellSummary, fileSummary, grepSummary, globSummary, searchSummary, fetchSummary, mcpSummary, subagentSummary, withResult, truncate } from '../utils/tool-summarizer.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';

const CLAUDE_PROJECTS_DIR = path.join(homeDir(), '.claude', 'projects');

interface ClaudeMessage {
  type: string;
  uuid: string;
  timestamp: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  parentUuid?: string;
}

/**
 * Find all Claude session files recursively
 */
async function findSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return files;
  }

  const walkDir = (dir: string): void => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('debug')) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(entry.name)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  };

  walkDir(CLAUDE_PROJECTS_DIR);
  return files;
}

/**
 * Parse session metadata and first user message
 */
async function parseSessionInfo(filePath: string): Promise<{
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  firstUserMessage: string;
}> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    let sessionId = '';
    let cwd = '';
    let gitBranch = '';
    let firstUserMessage = '';
    let linesRead = 0;

    rl.on('line', (line) => {
      linesRead++;
      if (linesRead > 50) {
        rl.close();
        stream.close();
        return;
      }

      try {
        const parsed = JSON.parse(line) as ClaudeMessage;
        if (parsed.sessionId && !sessionId) sessionId = parsed.sessionId;
        if (parsed.cwd && !cwd) cwd = parsed.cwd;
        if (parsed.gitBranch && !gitBranch) gitBranch = parsed.gitBranch;
        
        // Extract first real user message (not meta/commands)
        if (!firstUserMessage && parsed.type === 'user' && parsed.message?.content) {
          const content = typeof parsed.message.content === 'string' 
            ? parsed.message.content 
            : parsed.message.content.find(c => c.type === 'text')?.text || '';
          
          // Skip command-like messages, meta content, and continuation summaries
          if (content && !content.startsWith('<') && !content.startsWith('/') && !content.includes('Session Handoff')) {
            firstUserMessage = content;
          }
        }
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => {
      if (!sessionId) {
        sessionId = path.basename(filePath, '.jsonl');
      }
      resolve({ sessionId, cwd, gitBranch, firstUserMessage });
    });

    rl.on('error', () => resolve({ sessionId: '', cwd: '', firstUserMessage: '' }));
  });
}

/**
 * Count lines and get file size
 */
async function getFileStats(filePath: string): Promise<{ lines: number; bytes: number }> {
  return new Promise((resolve) => {
    const stats = fs.statSync(filePath);
    let lines = 0;
    
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    rl.on('line', () => lines++);
    rl.on('close', () => resolve({ lines, bytes: stats.size }));
    rl.on('error', () => resolve({ lines: 0, bytes: stats.size }));
  });
}

/**
 * Parse all Claude sessions
 */
export async function parseClaudeSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const info = await parseSessionInfo(filePath);
      const stats = await getFileStats(filePath);
      const fileStats = fs.statSync(filePath);

      // Use first user message as summary
      const summary = cleanSummary(info.firstUserMessage);

      const repo = extractRepoFromCwd(info.cwd);

      sessions.push({
        id: info.sessionId,
        source: 'claude',
        cwd: info.cwd,
        repo,
        branch: info.gitBranch,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: fileStats.birthtime,
        updatedAt: fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
      });
    } catch {
      // Skip files we can't parse
    }
  }

  return sessions
    .filter(s => s.bytes > 200)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Read all messages from a Claude session
 */
async function readAllMessages(filePath: string): Promise<ClaudeMessage[]> {
  return new Promise((resolve) => {
    const messages: ClaudeMessage[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    rl.on('line', (line) => {
      try {
        messages.push(JSON.parse(line) as ClaudeMessage);
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => resolve(messages));
    rl.on('error', () => resolve(messages));
  });
}

/**
 * Extract content from Claude message
 */
function extractContent(msg: ClaudeMessage): string {
  if (!msg.message?.content) return '';
  
  if (typeof msg.message.content === 'string') {
    return msg.message.content;
  }
  
  return msg.message.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text)
    .join('\n');
}

/**
 * Tools to skip — they don't carry useful handoff context
 */
const CLAUDE_SKIP_TOOLS = new Set(['TaskStop', 'ExitPlanMode']);

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector
 */
function extractToolData(messages: ClaudeMessage[]): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector();
  const toolResultMap = new Map<string, string>();

  // First pass: collect all tool_result blocks
  for (const msg of messages) {
    if (!msg.message?.content || typeof msg.message.content === 'string') continue;
    for (const item of msg.message.content) {
      if (item.type !== 'tool_result') continue;
      const tr = item as any;
      if (!tr.tool_use_id) continue;
      let text = '';
      if (typeof tr.content === 'string') text = tr.content;
      else if (Array.isArray(tr.content)) {
        text = tr.content.find((c: any) => c.type === 'text')?.text || '';
      }
      if (text) toolResultMap.set(tr.tool_use_id, text.slice(0, 100));
    }
  }

  // Second pass: process tool_use blocks
  for (const msg of messages) {
    if (!msg.message?.content || typeof msg.message.content === 'string') continue;
    for (const item of msg.message.content) {
      if (item.type !== 'tool_use') continue;
      const { name, input = {}, id: toolUseId } = item as any;
      if (!name || CLAUDE_SKIP_TOOLS.has(name)) continue;

      const result = toolUseId ? toolResultMap.get(toolUseId) : undefined;
      const fp = input.file_path || input.path || '';

      if (name === 'Bash' || name === 'bash') {
        collector.add('Bash', shellSummary(input.command || '', result));
      } else if (['Read', 'ReadFile', 'read_file'].includes(name)) {
        collector.add(name, withResult(fileSummary('read', fp), result), fp);
      } else if (['Write', 'WriteFile', 'write_file'].includes(name)) {
        collector.add(name, withResult(fileSummary('write', fp), result), fp, true);
      } else if (['Edit', 'EditFile', 'edit_file'].includes(name)) {
        collector.add(name, withResult(fileSummary('edit', fp), result), fp, true);
      } else if (name === 'Grep') {
        collector.add('Grep', withResult(grepSummary(input.pattern || '', input.path), result));
      } else if (name === 'Glob') {
        collector.add('Glob', withResult(globSummary(input.pattern || ''), result));
      } else if (name === 'WebFetch') {
        collector.add('WebFetch', fetchSummary(input.url || ''));
      } else if (name === 'WebSearch') {
        collector.add('WebSearch', searchSummary(input.query || ''));
      } else if (name === 'Task') {
        collector.add('Task', subagentSummary(input.description || '', input.subagent_type || ''));
      } else if (name === 'TaskOutput') {
        collector.add('TaskOutput', subagentSummary(input.content || input.result || '', input.subagent_type || ''));
      } else if (name === 'AskUserQuestion') {
        collector.add('AskUserQuestion', `ask: "${truncate(input.question || '', 80)}"`);
      } else if (name.startsWith('mcp__') || name.includes('-')) {
        collector.add(name, mcpSummary(name, JSON.stringify(input).slice(0, 100), result));
      } else {
        collector.add(name, withResult(`${name}(${JSON.stringify(input).slice(0, 100)})`, result));
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes from thinking blocks and model info
 */
function extractSessionNotes(messages: ClaudeMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  for (const msg of messages) {
    if ((msg as any).model && !notes.model) {
      notes.model = (msg as any).model;
    }
    if (!msg.message?.content || typeof msg.message.content === 'string') continue;
    for (const item of msg.message.content) {
      if ((item as any).type === 'thinking' && reasoning.length < 5) {
        const text = (item as any).text || '';
        if (text.length > 20) {
          const firstLine = text.split(/[.\n]/)[0]?.trim();
          if (firstLine) reasoning.push(truncate(firstLine, 200));
        }
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Extract context from a Claude session for cross-tool continuation
 */
export async function extractClaudeContext(session: UnifiedSession): Promise<SessionContext> {
  const messages = await readAllMessages(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  
  const { summaries: toolSummaries, filesModified } = extractToolData(messages);
  const sessionNotes = extractSessionNotes(messages);
  const pendingTasks: string[] = [];

  for (const msg of messages.slice(-20)) {
    if (msg.type === 'queue-operation' || msg.type === 'system') continue;
    if ((msg as any).isCompactSummary) continue;

    if (msg.type === 'user') {
      const content = extractContent(msg);
      if (content) {
        recentMessages.push({ role: 'user', content, timestamp: new Date(msg.timestamp) });
      }
    } else if (msg.type === 'assistant') {
      const content = extractContent(msg);
      if (content) {
        recentMessages.push({ role: 'assistant', content, timestamp: new Date(msg.timestamp) });
      }
    }
  }

  const markdown = generateHandoffMarkdown(session, recentMessages.slice(-10), filesModified, pendingTasks, toolSummaries, sessionNotes);

  return {
    session,
    recentMessages: recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

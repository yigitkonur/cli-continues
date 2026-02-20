import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { UnifiedSession, SessionContext, ConversationMessage, ToolUsageSummary, SessionNotes } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { SummaryCollector, shellSummary, searchSummary, mcpSummary, withResult, truncate } from '../utils/tool-summarizer.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';

const CODEX_SESSIONS_DIR = path.join(homeDir(), '.codex', 'sessions');

interface CodexSessionMeta {
  timestamp: string;
  type: string;
  payload?: {
    id?: string;
    cwd?: string;
    git?: {
      branch?: string;
      repository_url?: string;
    };
  };
}

interface CodexEventMsg {
  timestamp: string;
  type: string;
  payload?: {
    type?: string;
    role?: string;
    message?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  message?: string;
}

// Union type for any Codex message
type CodexMessage = CodexSessionMeta | CodexEventMsg;

/**
 * Find all Codex session files recursively
 */
async function findSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    return files;
  }

  const walkDir = (dir: string): void => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  };

  walkDir(CODEX_SESSIONS_DIR);
  return files;
}

/**
 * Parse session metadata and first user message
 */
async function parseSessionInfo(filePath: string): Promise<{
  meta: CodexSessionMeta | null;
  firstUserMessage: string;
}> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    let meta: CodexSessionMeta | null = null;
    let firstUserMessage = '';
    let linesRead = 0;

    rl.on('line', (line) => {
      linesRead++;
      // Read more lines to find user message (increased from 50)
      if (linesRead > 150) {
        rl.close();
        stream.close();
        return;
      }

      try {
        const parsed = JSON.parse(line);
        
        // Get session meta
        if (parsed.type === 'session_meta' && !meta) {
          meta = parsed as CodexSessionMeta;
        }
        
        // Get first user message from event_msg
        if (!firstUserMessage && parsed.type === 'event_msg' && parsed.payload?.type === 'user_message') {
          firstUserMessage = parsed.payload.message || '';
        }
        
        // Also check for input_text or message types (older formats)
        if (!firstUserMessage && parsed.type === 'message' && parsed.role === 'user') {
          firstUserMessage = typeof parsed.content === 'string' ? parsed.content : '';
        }
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => resolve({ meta, firstUserMessage }));
    rl.on('error', () => resolve({ meta: null, firstUserMessage: '' }));
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
 * Extract repo name from git URL or cwd
 */
function extractRepoName(gitUrl?: string, cwd?: string): string {
  if (gitUrl) {
    // Parse: https://github.com/owner/repo.git or git@github.com:owner/repo.git
    const match = gitUrl.match(/[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  }
  
  if (cwd) {
    // Get last 2 path components for context
    const parts = cwd.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(-2).join('/');
    }
    return parts[parts.length - 1] || '';
  }
  
  return '';
}

/**
 * Parse all Codex sessions
 */
export async function parseCodexSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const filename = path.basename(filePath);
      const parsed = parseFilename(filename);
      if (!parsed) continue;

      const { meta, firstUserMessage } = await parseSessionInfo(filePath);
      const stats = await getFileStats(filePath);
      const fileStats = fs.statSync(filePath);

      // Extract cwd from meta, fallback to nothing
      const cwd = meta?.payload?.cwd || '';
      const gitUrl = meta?.payload?.git?.repository_url;
      const branch = meta?.payload?.git?.branch;
      const repo = extractRepoName(gitUrl, cwd);

      // Use first user message as summary (cleaned up)
      const summary = cleanSummary(firstUserMessage);

      sessions.push({
        id: parsed.id,
        source: 'codex',
        cwd,
        repo,
        branch,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: parsed.timestamp,
        updatedAt: fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
      });
    } catch {
      // Skip files we can't parse
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Read all messages from a Codex session
 */
async function readAllMessages(filePath: string): Promise<CodexMessage[]> {
  return new Promise((resolve) => {
    const messages: CodexMessage[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    rl.on('line', (line) => {
      try {
        messages.push(JSON.parse(line) as CodexMessage);
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => resolve(messages));
    rl.on('error', () => resolve(messages));
  });
}

/**
 * Common shell tool base commands for category grouping
 */
const COMMON_SHELL_TOOLS = new Set([
  'npm', 'git', 'node', 'python', 'find', 'grep', 'cat', 'ls', 'tree',
  'mkdir', 'rm', 'sed', 'awk', 'curl', 'wget', 'docker', 'make',
  'cargo', 'go', 'pip', 'pnpm', 'yarn', 'bun', 'deno',
]);

/**
 * Track file modifications from shell command patterns (sed -i, >, tee, mv, cp)
 */
function trackShellFileWrites(cmd: string, collector: SummaryCollector): void {
  const sedMatch = cmd.match(/sed\s+-i[^'"]*\s+[^'"]*\s+['"]?([^\s'"]+)/);
  if (sedMatch) { collector.trackFile(sedMatch[1]); return; }
  const redirectMatch = cmd.match(/>\s*['"]?([^\s;|&'"]+)/);
  if (redirectMatch && !redirectMatch[1].startsWith('>')) { collector.trackFile(redirectMatch[1]); return; }
  const teeMatch = cmd.match(/tee\s+['"]?([^\s;|&'"]+)/);
  if (teeMatch) { collector.trackFile(teeMatch[1]); return; }
  const mvCpMatch = cmd.match(/^(mv|cp)\s+.*\s+['"]?([^\s;|&'"]+)$/);
  if (mvCpMatch) { collector.trackFile(mvCpMatch[2]); }
}

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector
 */
function extractToolData(messages: CodexMessage[]): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector();
  const outputsById = new Map<string, string>();

  // First pass: collect function_call_output and custom_tool_call_output by call_id
  for (const msg of messages) {
    if (msg.type !== 'response_item') continue;
    const payload = (msg as any).payload;
    if ((payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') && payload.call_id && payload.output) {
      outputsById.set(payload.call_id, typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output));
    }
  }

  // Second pass: extract tool calls
  for (const msg of messages) {
    const payload = (msg as any).payload;
    if (!payload) continue;

    // function_call
    if (msg.type === 'response_item' && payload.type === 'function_call' && payload.arguments) {
      try {
        const args = JSON.parse(payload.arguments);
        const name = payload.name as string;
        const output = payload.call_id ? outputsById.get(payload.call_id) : undefined;

        if (name === 'exec_command' || name === 'shell_command') {
          const cmd = (args.cmd || args.command || '') as string;
          if (!cmd) continue;
          const baseCmd = cmd.trim().split(/\s+/)[0];
          const category = COMMON_SHELL_TOOLS.has(baseCmd) ? baseCmd : 'shell';
          collector.add(category, shellSummary(cmd, output));
          trackShellFileWrites(cmd, collector);
        } else if (name === 'write_stdin') {
          collector.add('write_stdin', `stdin: "${truncate((args.input || args.data || '') as string, 60)}"`);
        } else if (['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates'].includes(name)) {
          collector.add('mcp-resource', `${name}: ${truncate((args.uri || args.server_label || '(all)') as string, 60)}`);
        } else if (name === 'request_user_input') {
          collector.add('user-input', `ask: "${truncate((args.prompt || args.message || '') as string, 60)}"`);
        } else if (name === 'update_plan') {
          collector.add('plan', `plan: "${truncate((args.explanation || '') as string, 60)}"`);
        } else if (name === 'view_image') {
          collector.add('view_image', `image: ${truncate((args.path || args.url || '') as string, 60)}`);
        } else if (name.startsWith('mcp__') || name.includes('-')) {
          collector.add(name, mcpSummary(name, JSON.stringify(args).slice(0, 100), output));
        } else {
          collector.add(name, withResult(`${name}(${JSON.stringify(args).slice(0, 80)})`, output));
        }
      } catch { /* skip unparseable arguments */ }
    }

    // custom_tool_call (e.g. apply_patch)
    if (msg.type === 'response_item' && payload.type === 'custom_tool_call' && payload.name) {
      const name = payload.name as string;
      const input = (payload.input || '') as string;
      if (name === 'apply_patch') {
        const fileMatches = input.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/g) || [];
        const files = fileMatches.map((m: string) => m.replace(/^\*\*\* (?:Add|Update|Delete) File: /, ''));
        const fileList = files.length > 0 ? files.slice(0, 3).join(', ') : '(patch)';
        collector.add('apply_patch', `patch: ${truncate(fileList, 70)}`);
        for (const f of files) collector.trackFile(f);
      } else {
        collector.add(name, `${name}: ${truncate(input, 80)}`);
      }
    }

    // web_search_call
    if (msg.type === 'response_item' && payload.type === 'web_search_call') {
      collector.add('web_search', searchSummary((payload.action?.query || payload.action?.queries?.[0] || '') as string));
    }

    // Task lifecycle events
    if (msg.type === 'event_msg') {
      if (payload.type === 'task_started') {
        collector.add('task', `task: started "${truncate(payload.message || '', 60)}"`);
      } else if (payload.type === 'task_complete') {
        collector.add('task', 'task: completed');
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes from reasoning events, model, and token usage
 */
function extractSessionNotes(messages: CodexMessage[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  for (const msg of messages) {
    // Model from turn_context
    if ((msg as any).type === 'turn_context') {
      const payload = (msg as any).payload;
      if (payload?.model && !notes.model) notes.model = payload.model;
    }

    if (msg.type !== 'event_msg') continue;
    const payload = (msg as any).payload;
    if (!payload) continue;

    if (payload.type === 'agent_reasoning' && reasoning.length < 5) {
      const text = (payload.message || '') as string;
      if (text.length > 20) {
        const firstLine = text.split(/[.\n]/)[0]?.trim();
        if (firstLine) reasoning.push(truncate(firstLine, 200));
      }
    }

    // Token usage (take last value — cumulative)
    if (payload.type === 'token_count') {
      notes.tokenUsage = { input: payload.input_tokens || 0, output: payload.output_tokens || 0 };
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Extract context from a Codex session for cross-tool continuation
 */
export async function extractCodexContext(session: UnifiedSession): Promise<SessionContext> {
  const messages = await readAllMessages(session.originalPath);
  
  const { summaries: toolSummaries, filesModified } = extractToolData(messages);
  const sessionNotes = extractSessionNotes(messages);
  const pendingTasks: string[] = [];

  // Codex sessions contain both response_item and event_msg for the same conversation turns.
  // Collect from both sources separately to avoid duplicates, then merge preferring response_item.
  const eventMsgEntries: ConversationMessage[] = [];
  const responseItemEntries: ConversationMessage[] = [];

  for (const msg of messages) {
    const eventMsg = msg as CodexEventMsg;

    if (msg.type === 'event_msg' && eventMsg.payload?.type === 'user_message') {
      const content = eventMsg.payload?.message || eventMsg.message || '';
      if (content) {
        eventMsgEntries.push({ role: 'user', content, timestamp: new Date(msg.timestamp) });
      }
    } else if (msg.type === 'event_msg' && (eventMsg.payload?.type === 'agent_message' || eventMsg.payload?.type === 'assistant_message')) {
      const content = eventMsg.payload?.message || '';
      if (content) {
        eventMsgEntries.push({ role: 'assistant', content, timestamp: new Date(msg.timestamp) });
      }
    } else if (msg.type === 'response_item' && eventMsg.payload?.role === 'user' && eventMsg.payload?.type === 'message') {
      const contentParts = eventMsg.payload?.content || [];
      const text = contentParts
        .filter((c: { type: string; text?: string }) => c.type === 'input_text' && c.text)
        .map((c: { type: string; text?: string }) => c.text)
        .join('\n');
      // Skip system-injected content (AGENTS.md instructions, environment_context, permissions)
      if (text && !text.startsWith('<environment_context>') && !text.startsWith('<permissions') && !text.startsWith('# AGENTS.md')) {
        responseItemEntries.push({ role: 'user', content: text, timestamp: new Date(msg.timestamp) });
      }
    } else if (msg.type === 'response_item' && eventMsg.payload?.role === 'assistant' && eventMsg.payload?.type === 'message') {
      const contentParts = eventMsg.payload?.content || [];
      const text = contentParts
        .filter((c: { type: string; text?: string }) => (c.type === 'output_text' || c.type === 'text') && c.text)
        .map((c: { type: string; text?: string }) => c.text)
        .join('\n');
      if (text) {
        responseItemEntries.push({ role: 'assistant', content: text, timestamp: new Date(msg.timestamp) });
      }
    }
    // Skip response_item with payload.type === 'reasoning' (chain-of-thought, not a message)
    // Skip response_item with payload.role === 'developer' (system instructions)
  }

  // Prefer response_item entries (newer, richer format) when available; fall back to event_msg
  const hasResponseItems = responseItemEntries.some(m => m.role === 'user') || responseItemEntries.some(m => m.role === 'assistant');
  const allMessages = hasResponseItems ? responseItemEntries : eventMsgEntries;

  // Build a balanced tail: keep the last 10 messages but ensure user messages aren't lost.
  // Codex sessions can have many consecutive assistant messages (status updates, subagent reports).
  let trimmed: ConversationMessage[];
  const tail = allMessages.slice(-10);
  const hasUser = tail.some(m => m.role === 'user');
  if (hasUser || allMessages.length <= 10) {
    trimmed = tail;
  } else {
    // Include the last user message + everything after it, capped at 10
    let lastUserIdx = -1;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx >= 0) {
      trimmed = allMessages.slice(lastUserIdx, lastUserIdx + 10);
    } else {
      trimmed = tail;
    }
  }

  // Generate markdown for injection
  const markdown = generateHandoffMarkdown(session, trimmed, filesModified, pendingTasks, toolSummaries, sessionNotes);

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

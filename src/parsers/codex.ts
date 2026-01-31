import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { UnifiedSession, SessionContext, ConversationMessage } from '../types/index.js';

const CODEX_SESSIONS_DIR = path.join(process.env.HOME || '~', '.codex', 'sessions');

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
      const summary = firstUserMessage
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50);

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
 * Extract context from a Codex session for cross-tool continuation
 */
export async function extractCodexContext(session: UnifiedSession): Promise<SessionContext> {
  const messages = await readAllMessages(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];

  // Process messages to extract conversation
  for (const msg of messages.slice(-50)) { // Last 50 events
    const eventMsg = msg as CodexEventMsg;
    if (msg.type === 'event_msg' && eventMsg.payload?.type === 'user_message') {
      const content = eventMsg.payload?.message || eventMsg.message || '';
      if (content) {
        recentMessages.push({
          role: 'user',
          content,
          timestamp: new Date(msg.timestamp),
        });
      }
    } else if (msg.type === 'event_msg' && eventMsg.payload?.type === 'assistant_message') {
      const content = eventMsg.payload?.message || '';
      if (content) {
        recentMessages.push({
          role: 'assistant',
          content,
          timestamp: new Date(msg.timestamp),
        });
      }
    }
  }

  // Generate markdown for injection
  const markdown = generateHandoffMarkdown(session, recentMessages.slice(-10), filesModified, pendingTasks);

  return {
    session,
    recentMessages: recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    markdown,
  };
}

/**
 * Generate markdown handoff document
 */
function generateHandoffMarkdown(
  session: UnifiedSession,
  messages: ConversationMessage[],
  filesModified: string[],
  pendingTasks: string[]
): string {
  const lines: string[] = [
    '# Session Handoff Context',
    '',
    '## Original Session',
    `- **Source**: Codex CLI`,
    `- **Session ID**: ${session.id}`,
    `- **Working Directory**: ${session.cwd}`,
    session.repo ? `- **Repository**: ${session.repo}${session.branch ? ` @ ${session.branch}` : ''}` : '',
    `- **Last Active**: ${session.updatedAt.toISOString()}`,
    '',
    '## Recent Conversation',
    '',
  ];

  for (const msg of messages.slice(-5)) {
    lines.push(`### ${msg.role === 'user' ? 'User' : 'Assistant'}`);
    lines.push(msg.content.slice(0, 500) + (msg.content.length > 500 ? '...' : ''));
    lines.push('');
  }

  if (filesModified.length > 0) {
    lines.push('## Files Modified');
    for (const file of filesModified) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }

  if (pendingTasks.length > 0) {
    lines.push('## Pending Tasks');
    for (const task of pendingTasks) {
      lines.push(`- [ ] ${task}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('**Continue this session. The context above summarizes the previous work.**');

  return lines.filter(l => l !== '').join('\n');
}

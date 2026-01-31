import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedSession, SessionContext, ConversationMessage } from '../types/index.js';

const OPENCODE_STORAGE_DIR = path.join(process.env.HOME || '~', '.local', 'share', 'opencode', 'storage');

interface OpenCodeSession {
  id: string;
  slug?: string;
  version?: string;
  projectID: string;
  directory: string;
  title?: string;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

interface OpenCodeProject {
  id: string;
  worktree: string;
  vcs?: string;
  time?: {
    created: number;
    updated: number;
  };
}

interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
    completed?: number;
  };
  summary?: {
    title?: string;
  };
  path?: {
    cwd?: string;
    root?: string;
  };
}

interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
}

/**
 * Find all OpenCode session files
 */
async function findSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  const sessionDir = path.join(OPENCODE_STORAGE_DIR, 'session');
  
  if (!fs.existsSync(sessionDir)) {
    return files;
  }

  try {
    // Iterate through project hash directories
    const projectDirs = fs.readdirSync(sessionDir, { withFileTypes: true });
    
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      
      const projectPath = path.join(sessionDir, projectDir.name);
      const sessionFiles = fs.readdirSync(projectPath, { withFileTypes: true });
      
      for (const sessionFile of sessionFiles) {
        if (sessionFile.isFile() && sessionFile.name.startsWith('ses_') && sessionFile.name.endsWith('.json')) {
          files.push(path.join(projectPath, sessionFile.name));
        }
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return files;
}

/**
 * Parse a single OpenCode session file
 */
function parseSessionFile(filePath: string): OpenCodeSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as OpenCodeSession;
  } catch {
    return null;
  }
}

/**
 * Load project info to get worktree/cwd
 */
function loadProjectInfo(projectId: string): OpenCodeProject | null {
  const projectFile = path.join(OPENCODE_STORAGE_DIR, 'project', `${projectId}.json`);
  try {
    if (fs.existsSync(projectFile)) {
      const content = fs.readFileSync(projectFile, 'utf8');
      return JSON.parse(content) as OpenCodeProject;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Get first user message from session messages
 */
function getFirstUserMessage(sessionId: string): string {
  const messageDir = path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
  if (!fs.existsSync(messageDir)) return '';

  try {
    const messageFiles = fs.readdirSync(messageDir)
      .filter(f => f.startsWith('msg_') && f.endsWith('.json'))
      .sort(); // Sort to get chronological order

    for (const msgFile of messageFiles) {
      const msgPath = path.join(messageDir, msgFile);
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msg = JSON.parse(msgContent) as OpenCodeMessage;
      
      if (msg.role === 'user') {
        // Get the message text from parts
        const messageId = msg.id;
        const partDir = path.join(OPENCODE_STORAGE_DIR, 'part', messageId);
        
        if (fs.existsSync(partDir)) {
          const partFiles = fs.readdirSync(partDir)
            .filter(f => f.startsWith('prt_') && f.endsWith('.json'))
            .sort();
          
          for (const partFile of partFiles) {
            const partPath = path.join(partDir, partFile);
            const partContent = fs.readFileSync(partPath, 'utf8');
            const part = JSON.parse(partContent) as OpenCodePart;
            
            if (part.type === 'text' && part.text) {
              return part.text;
            }
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return '';
}

/**
 * Extract repo name from worktree path
 */
function extractRepoFromPath(worktree: string): string {
  const parts = worktree.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return parts[parts.length - 1] || '';
}

/**
 * Count message lines for a session
 */
function countSessionLines(sessionId: string): number {
  const messageDir = path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
  if (!fs.existsSync(messageDir)) return 0;

  try {
    const messageFiles = fs.readdirSync(messageDir)
      .filter(f => f.startsWith('msg_') && f.endsWith('.json'));
    return messageFiles.length;
  } catch {
    return 0;
  }
}

/**
 * Parse all OpenCode sessions
 */
export async function parseOpenCodeSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const session = parseSessionFile(filePath);
      if (!session || !session.id) continue;

      // Get project info for worktree
      const project = loadProjectInfo(session.projectID);
      const cwd = session.directory || project?.worktree || '';
      
      // Get first user message for summary
      const firstUserMessage = getFirstUserMessage(session.id);
      const summary = session.title || firstUserMessage
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50);

      const fileStats = fs.statSync(filePath);
      const lines = countSessionLines(session.id);

      sessions.push({
        id: session.id,
        source: 'opencode',
        cwd,
        repo: extractRepoFromPath(cwd),
        lines,
        bytes: fileStats.size,
        createdAt: new Date(session.time.created),
        updatedAt: new Date(session.time.updated),
        originalPath: filePath,
        summary: summary || session.slug || undefined,
      });
    } catch {
      // Skip files we can't parse
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Read all messages from an OpenCode session
 */
function readAllMessages(sessionId: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const messageDir = path.join(OPENCODE_STORAGE_DIR, 'message', sessionId);
  
  if (!fs.existsSync(messageDir)) return messages;

  try {
    const messageFiles = fs.readdirSync(messageDir)
      .filter(f => f.startsWith('msg_') && f.endsWith('.json'))
      .sort();

    for (const msgFile of messageFiles) {
      const msgPath = path.join(messageDir, msgFile);
      const msgContent = fs.readFileSync(msgPath, 'utf8');
      const msg = JSON.parse(msgContent) as OpenCodeMessage;
      
      // Get message text from parts
      const partDir = path.join(OPENCODE_STORAGE_DIR, 'part', msg.id);
      let text = '';
      
      if (fs.existsSync(partDir)) {
        const partFiles = fs.readdirSync(partDir)
          .filter(f => f.startsWith('prt_') && f.endsWith('.json'))
          .sort();
        
        for (const partFile of partFiles) {
          const partPath = path.join(partDir, partFile);
          const partContent = fs.readFileSync(partPath, 'utf8');
          const part = JSON.parse(partContent) as OpenCodePart;
          
          if (part.type === 'text' && part.text) {
            text += part.text + '\n';
          }
        }
      }

      if (text.trim()) {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: text.trim(),
          timestamp: new Date(msg.time.created),
        });
      }
    }
  } catch {
    // Ignore errors
  }

  return messages;
}

/**
 * Extract context from an OpenCode session for cross-tool continuation
 */
export async function extractOpenCodeContext(session: UnifiedSession): Promise<SessionContext> {
  const recentMessages = readAllMessages(session.id);
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];

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
    `- **Source**: OpenCode`,
    `- **Session ID**: ${session.id}`,
    `- **Working Directory**: ${session.cwd}`,
    session.repo ? `- **Repository**: ${session.repo}` : '',
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

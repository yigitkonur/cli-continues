import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import YAML from 'yaml';
import type { UnifiedSession, SessionContext, ConversationMessage } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { homeDir } from '../utils/parser-helpers.js';

const COPILOT_SESSIONS_DIR = path.join(homeDir(), '.copilot', 'session-state');

interface CopilotWorkspace {
  id: string;
  cwd: string;
  git_root?: string;
  repository?: string;
  branch?: string;
  summary?: string;
  summary_count?: number;
  created_at: string;
  updated_at: string;
}

interface CopilotEvent {
  type: string;
  id: string;
  timestamp: string;
  parentId?: string | null;
  data?: {
    sessionId?: string;
    selectedModel?: string;
    content?: string;
    transformedContent?: string;
    messageId?: string;
    toolRequests?: Array<{
      name: string;
      arguments?: Record<string, unknown>;
    }>;
    context?: {
      cwd?: string;
      gitRoot?: string;
      branch?: string;
      repository?: string;
    };
  };
}

/**
 * Find all Copilot session directories
 */
async function findSessionDirs(): Promise<string[]> {
  const dirs: string[] = [];
  
  if (!fs.existsSync(COPILOT_SESSIONS_DIR)) {
    return dirs;
  }

  try {
    const entries = fs.readdirSync(COPILOT_SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionDir = path.join(COPILOT_SESSIONS_DIR, entry.name);
        const workspaceFile = path.join(sessionDir, 'workspace.yaml');
        
        // Must have workspace.yaml to be a valid session
        if (fs.existsSync(workspaceFile)) {
          dirs.push(sessionDir);
        }
      }
    }
  } catch {
    // Skip if we can't read the directory
  }

  return dirs;
}

/**
 * Parse workspace.yaml file
 */
function parseWorkspace(workspacePath: string): CopilotWorkspace | null {
  try {
    const content = fs.readFileSync(workspacePath, 'utf8');
    return YAML.parse(content) as CopilotWorkspace;
  } catch {
    return null;
  }
}

/**
 * Count lines and get file size for events.jsonl
 */
async function getEventsStats(eventsPath: string): Promise<{ lines: number; bytes: number }> {
  if (!fs.existsSync(eventsPath)) {
    return { lines: 0, bytes: 0 };
  }

  return new Promise((resolve) => {
    const stats = fs.statSync(eventsPath);
    let lines = 0;
    
    const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    rl.on('line', () => lines++);
    rl.on('close', () => resolve({ lines, bytes: stats.size }));
    rl.on('error', () => resolve({ lines: 0, bytes: stats.size }));
  });
}

/**
 * Extract model from events.jsonl
 */
async function extractModel(eventsPath: string): Promise<string | undefined> {
  if (!fs.existsSync(eventsPath)) {
    return undefined;
  }

  return new Promise((resolve) => {
    const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line) as CopilotEvent;
        if (event.type === 'session.start' && event.data?.selectedModel) {
          rl.close();
          stream.close();
          resolve(event.data.selectedModel);
          return;
        }
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => resolve(undefined));
    rl.on('error', () => resolve(undefined));
  });
}

/**
 * Parse all Copilot sessions
 */
export async function parseCopilotSessions(): Promise<UnifiedSession[]> {
  const dirs = await findSessionDirs();
  const sessions: UnifiedSession[] = [];

  for (const sessionDir of dirs) {
    try {
      const workspacePath = path.join(sessionDir, 'workspace.yaml');
      const eventsPath = path.join(sessionDir, 'events.jsonl');
      
      const workspace = parseWorkspace(workspacePath);
      if (!workspace) continue;

      const stats = await getEventsStats(eventsPath);
      const model = await extractModel(eventsPath);

      // Parse summary - handle multiline YAML
      let summary = workspace.summary || '';
      if (summary.startsWith('|')) {
        summary = summary.replace(/^\|\n?/, '').split('\n')[0];
      }

      sessions.push({
        id: workspace.id,
        source: 'copilot',
        cwd: workspace.cwd,
        repo: workspace.repository,
        branch: workspace.branch,
        lines: stats.lines,
        bytes: stats.bytes,
        createdAt: new Date(workspace.created_at),
        updatedAt: new Date(workspace.updated_at),
        originalPath: sessionDir,
        summary: summary.slice(0, 60),
        model,
      });
    } catch {
      // Skip sessions we can't parse
    }
  }

  // Filter out empty sessions and sort by update time
  return sessions
    .filter(s => s.bytes > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Read all events from a Copilot session
 */
async function readAllEvents(eventsPath: string): Promise<CopilotEvent[]> {
  if (!fs.existsSync(eventsPath)) {
    return [];
  }

  return new Promise((resolve) => {
    const events: CopilotEvent[] = [];
    const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    rl.on('line', (line) => {
      try {
        events.push(JSON.parse(line) as CopilotEvent);
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => resolve(events));
    rl.on('error', () => resolve(events));
  });
}

/**
 * Extract context from a Copilot session for cross-tool continuation
 */
export async function extractCopilotContext(session: UnifiedSession): Promise<SessionContext> {
  const eventsPath = path.join(session.originalPath, 'events.jsonl');
  const events = await readAllEvents(eventsPath);
  
  const recentMessages: ConversationMessage[] = [];
  const filesModified: string[] = [];
  const pendingTasks: string[] = [];

  // Process events to extract conversation
  for (const event of events.slice(-20)) {
    if (event.type === 'user.message') {
      const content = event.data?.content || event.data?.transformedContent || '';
      if (content) {
        recentMessages.push({
          role: 'user',
          content,
          timestamp: new Date(event.timestamp),
        });
      }
    } else if (event.type === 'assistant.message') {
      const content = event.data?.content || '';
      const toolRequests = event.data?.toolRequests || [];

      if (content) {
        recentMessages.push({
          role: 'assistant',
          content: typeof content === 'string' ? content : JSON.stringify(content),
          timestamp: new Date(event.timestamp),
          toolCalls: toolRequests.length > 0
            ? toolRequests.map(t => ({ name: t.name, arguments: t.arguments }))
            : undefined,
        });
      } else if (toolRequests.length > 0) {
        // Assistant message with only tool calls (no text content)
        const toolNames = toolRequests.map(t => t.name).join(', ');
        recentMessages.push({
          role: 'assistant',
          content: `[Used tools: ${toolNames}]`,
          timestamp: new Date(event.timestamp),
          toolCalls: toolRequests.map(t => ({ name: t.name, arguments: t.arguments })),
        });
      }
    }
  }

  // If no conversation messages were found, synthesize from workspace summary
  if (recentMessages.length === 0 && session.summary) {
    recentMessages.push({
      role: 'user',
      content: session.summary,
      timestamp: session.createdAt,
    });
    recentMessages.push({
      role: 'assistant',
      content: `[Session worked on: ${session.summary}]`,
      timestamp: session.updatedAt,
    });
  }

  // Generate markdown for injection
  const markdown = generateHandoffMarkdown(session, recentMessages.slice(-10), filesModified, pendingTasks, []);

  return {
    session,
    recentMessages: recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    toolSummaries: [],
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

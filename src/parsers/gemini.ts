import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedSession, SessionContext, ConversationMessage, ToolUsageSummary, SessionNotes } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { SummaryCollector, fileSummary, mcpSummary, truncate } from '../utils/tool-summarizer.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';

const GEMINI_BASE_DIR = path.join(homeDir(), '.gemini', 'tmp');

interface GeminiToolCall {
  name: string;
  args?: Record<string, unknown>;
  result?: Array<{ functionResponse?: { response?: { output?: string } } }>;
  status?: string;
  resultDisplay?: {
    fileName?: string;
    filePath?: string;
    fileDiff?: string;
    originalContent?: string;
    newContent?: string;
    diffStat?: {
      model_added_lines?: number;
      model_removed_lines?: number;
    };
    isNewFile?: boolean;
  };
}

interface GeminiThought {
  subject?: string;
  description?: string;
  timestamp?: string;
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini' | 'info';
  content: string | Array<{ text?: string; type?: string }>;
  toolCalls?: GeminiToolCall[];
  thoughts?: GeminiThought[];
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    tool?: number;
    total?: number;
  };
}

interface GeminiSession {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiMessage[];
}

/**
 * Find all Gemini session files
 */
async function findSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  
  if (!fs.existsSync(GEMINI_BASE_DIR)) {
    return files;
  }

  try {
    // Iterate through project hash directories
    const projectDirs = fs.readdirSync(GEMINI_BASE_DIR, { withFileTypes: true });
    
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory() || projectDir.name === 'bin') continue;
      
      const chatsDir = path.join(GEMINI_BASE_DIR, projectDir.name, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      
      const chatFiles = fs.readdirSync(chatsDir, { withFileTypes: true });
      for (const chatFile of chatFiles) {
        if (chatFile.isFile() && chatFile.name.startsWith('session-') && chatFile.name.endsWith('.json')) {
          files.push(path.join(chatsDir, chatFile.name));
        }
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return files;
}

/**
 * Parse a single Gemini session file
 */
function parseSessionFile(filePath: string): GeminiSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as GeminiSession;
  } catch {
    return null;
  }
}

/**
 * Extract text content from Gemini message (handles both string and array formats)
 */
function extractGeminiContent(content: string | Array<{ text?: string; type?: string }>): string {
  if (typeof content === 'string') {
    return content;
  }
  
  if (Array.isArray(content)) {
    return content
      .filter(part => part.text)
      .map(part => part.text)
      .join('\n');
  }
  
  return '';
}

/**
 * Extract first real user message from Gemini session
 */
function extractFirstUserMessage(session: GeminiSession): string {
  for (const msg of session.messages) {
    if (msg.type === 'user' && msg.content) {
      return extractGeminiContent(msg.content);
    }
  }
  return '';
}

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector
 */
function extractToolData(sessionData: GeminiSession): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector();

  for (const msg of sessionData.messages) {
    if (msg.type !== 'gemini' || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      const { name, args, result, resultDisplay } = tc;

      if (name === 'write_file') {
        const fp = resultDisplay?.filePath || (args?.file_path as string) || '';
        let diffStat: { added: number; removed: number } | undefined;
        if (resultDisplay?.diffStat) {
          diffStat = { added: resultDisplay.diffStat.model_added_lines || 0, removed: resultDisplay.diffStat.model_removed_lines || 0 };
        } else if (resultDisplay?.fileDiff) {
          const lines = resultDisplay.fileDiff.split('\n');
          diffStat = { added: lines.filter(l => l.startsWith('+')).length, removed: lines.filter(l => l.startsWith('-')).length };
        }
        collector.add('write_file', fileSummary('write', fp, diffStat, resultDisplay?.isNewFile), fp, true);
      } else if (name === 'read_file') {
        const fp = (args?.file_path as string) || '';
        collector.add('read_file', fileSummary('read', fp), fp);
      } else {
        const argsStr = args ? JSON.stringify(args).slice(0, 100) : '';
        const resultStr = result?.[0]?.functionResponse?.response?.output;
        collector.add(name, mcpSummary(name, argsStr, resultStr));
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes from thoughts, model info, and token usage
 */
function extractSessionNotes(sessionData: GeminiSession): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  for (const msg of sessionData.messages) {
    if (msg.type !== 'gemini') continue;

    if (msg.model && !notes.model) notes.model = msg.model;

    if (msg.tokens) {
      if (!notes.tokenUsage) notes.tokenUsage = { input: 0, output: 0 };
      notes.tokenUsage.input += msg.tokens.input || 0;
      notes.tokenUsage.output += msg.tokens.output || 0;
    }

    if (msg.thoughts && reasoning.length < 5) {
      for (const thought of msg.thoughts) {
        if (reasoning.length >= 5) break;
        const text = thought.description || thought.subject || '';
        if (text.length > 10) reasoning.push(truncate(text, 200));
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Parse all Gemini sessions
 */
export async function parseGeminiSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const session = parseSessionFile(filePath);
      if (!session || !session.sessionId) continue;

      // Get cwd from parent directory structure (project hash dir)
      const projectHashDir = path.dirname(path.dirname(filePath));
      const projectHash = path.basename(projectHashDir);
      
      // Gemini does not store working directory in its session data
      const cwd = '';
      
      const firstUserMessage = extractFirstUserMessage(session);
      const summary = cleanSummary(firstUserMessage);

      const fileStats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').length;

      sessions.push({
        id: session.sessionId,
        source: 'gemini',
        cwd,
        repo: '',
        lines,
        bytes: fileStats.size,
        createdAt: new Date(session.startTime),
        updatedAt: new Date(session.lastUpdated),
        originalPath: filePath,
        summary: summary || undefined,
      });
    } catch {
      // Skip files we can't parse
    }
  }

  // Filter sessions that have real user messages (not just auth flows)
  return sessions
    .filter(s => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Gemini session for cross-tool continuation
 */
export async function extractGeminiContext(session: UnifiedSession): Promise<SessionContext> {
  const sessionData = parseSessionFile(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  let filesModified: string[] = [];
  const pendingTasks: string[] = [];
  let toolSummaries: ToolUsageSummary[] = [];
  let sessionNotes: SessionNotes | undefined;

  if (sessionData) {
    const toolData = extractToolData(sessionData);
    toolSummaries = toolData.summaries;
    filesModified = toolData.filesModified;
    sessionNotes = extractSessionNotes(sessionData);

    for (const msg of sessionData.messages.slice(-20)) {
      // Extract pending tasks from thoughts
      if (msg.type === 'gemini' && msg.thoughts && pendingTasks.length < 5) {
        for (const thought of msg.thoughts) {
          if (pendingTasks.length >= 5) break;
          const subject = thought.subject?.toLowerCase() || '';
          const description = thought.description?.toLowerCase() || '';
          if (subject.includes('todo') || subject.includes('next') || 
              subject.includes('remaining') || subject.includes('need to') ||
              description.includes('need to') || description.includes('next step')) {
            const taskText = thought.subject || thought.description || '';
            if (taskText && taskText.length > 0) pendingTasks.push(taskText);
          }
        }
      }

      if (msg.type === 'user') {
        recentMessages.push({
          role: 'user',
          content: extractGeminiContent(msg.content),
          timestamp: new Date(msg.timestamp),
        });
      } else if (msg.type === 'gemini') {
        const textContent = extractGeminiContent(msg.content);
        if (textContent) {
          recentMessages.push({
            role: 'assistant',
            content: textContent,
            timestamp: new Date(msg.timestamp),
          });
        }
      }
    }
  }

  const markdown = generateHandoffMarkdown(
    session,
    recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
  );

  return {
    session: sessionNotes?.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: recentMessages.slice(-10),
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

// generateHandoffMarkdown is imported from ../utils/markdown.js

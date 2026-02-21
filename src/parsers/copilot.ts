import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, UnifiedSession } from '../types/index.js';
import type { CopilotEvent, CopilotWorkspace } from '../types/schemas.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { homeDir } from '../utils/parser-helpers.js';

const COPILOT_SESSIONS_DIR = path.join(homeDir(), '.copilot', 'session-state');

/**
 * Find all Copilot session directories
 */
async function findSessionDirs(): Promise<string[]> {
  return listSubdirectories(COPILOT_SESSIONS_DIR).filter((dir) => fs.existsSync(path.join(dir, 'workspace.yaml')));
}

/**
 * Parse workspace.yaml file
 */
function parseWorkspace(workspacePath: string): CopilotWorkspace | null {
  try {
    const content = fs.readFileSync(workspacePath, 'utf8');
    return YAML.parse(content) as CopilotWorkspace;
  } catch (err) {
    logger.debug('copilot: failed to parse workspace YAML', workspacePath, err);
    return null;
  }
}

/**
 * Extract model from events.jsonl
 */
async function extractModel(eventsPath: string): Promise<string | undefined> {
  let model: string | undefined;

  await scanJsonlHead(eventsPath, 50, (parsed) => {
    const event = parsed as CopilotEvent;
    if (event.type === 'session.start' && event.data?.selectedModel) {
      model = event.data.selectedModel;
      return 'stop';
    }
    return 'continue';
  });

  return model;
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

      const stats = fs.existsSync(eventsPath) ? await getFileStats(eventsPath) : { lines: 0, bytes: 0 };
      const model = await extractModel(eventsPath);

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
    } catch (err) {
      logger.debug('copilot: skipping unparseable session', sessionDir, err);
      // Skip sessions we can't parse
    }
  }

  return sessions.filter((s) => s.bytes > 0).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Copilot session for cross-tool continuation
 */
export async function extractCopilotContext(session: UnifiedSession): Promise<SessionContext> {
  const eventsPath = path.join(session.originalPath, 'events.jsonl');
  const events = await readJsonlFile<CopilotEvent>(eventsPath);

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
          toolCalls:
            toolRequests.length > 0 ? toolRequests.map((t) => ({ name: t.name, arguments: t.arguments })) : undefined,
        });
      } else if (toolRequests.length > 0) {
        // Assistant message with only tool calls (no text content)
        const toolNames = toolRequests.map((t) => t.name).join(', ');
        recentMessages.push({
          role: 'assistant',
          content: `[Used tools: ${toolNames}]`,
          timestamp: new Date(event.timestamp),
          toolCalls: toolRequests.map((t) => ({ name: t.name, arguments: t.arguments })),
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

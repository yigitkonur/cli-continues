import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, UnifiedSession } from '../types/index.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { getFileStats, scanJsonlFile } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepo, homeDir } from '../utils/parser-helpers.js';
import { cwdFromSlug } from '../utils/slug.js';
import { fileSummary, SummaryCollector, shellSummary } from '../utils/tool-summarizer.js';

const COMMAND_CODE_HOME =
  process.env.COMMAND_CODE_HOME ?? path.join(homeDir(), '.commandcode');
const PROJECTS_DIR = path.join(COMMAND_CODE_HOME, 'projects');

interface CommandCodeMeta {
  title?: string;
  model?: string;
}

interface CommandCodeContentBlock {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
}

interface CommandCodeRecord {
  id?: string;
  sessionId?: string;
  timestamp?: string;
  role?: string;
  content?: CommandCodeContentBlock[];
  gitBranch?: string;
}

async function readMeta(metaPath: string): Promise<CommandCodeMeta> {
  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    return JSON.parse(raw) as CommandCodeMeta;
  } catch {
    return {};
  }
}

function joinTextBlocks(content: CommandCodeContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

export async function parseCommandCodeSessions(): Promise<UnifiedSession[]> {
  const sessions: UnifiedSession[] = [];

  let projectDirs: string[];
  try {
    projectDirs = listSubdirectories(PROJECTS_DIR);
  } catch {
    return sessions;
  }

  for (const projectDir of projectDirs) {
    const slug = path.basename(projectDir);
    const cwd = cwdFromSlug(slug);

    let entries: string[];
    try {
      const all = await fsp.readdir(projectDir);
      entries = all.filter((f) => f.endsWith('.jsonl') && !f.endsWith('.checkpoints.jsonl'));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const sessionId = path.basename(entry, '.jsonl');
      const jsonlPath = path.join(projectDir, entry);
      const metaPath = path.join(projectDir, `${sessionId}.meta.json`);

      try {
        const [stats, meta] = await Promise.all([getFileStats(jsonlPath), readMeta(metaPath)]);

        let branch: string | undefined;
        let firstTimestamp: Date | undefined;
        let lastTimestamp: Date | undefined;

        await scanJsonlFile(jsonlPath, (parsed) => {
          const rec = parsed as CommandCodeRecord;
          if (rec.gitBranch && !branch) branch = rec.gitBranch;
          if (rec.timestamp) {
            const ts = new Date(rec.timestamp);
            if (!firstTimestamp) firstTimestamp = ts;
            lastTimestamp = ts;
          }
          return 'continue';
        });

        const createdAt = firstTimestamp ?? new Date(0);
        const updatedAt = lastTimestamp ?? createdAt;
        const summary = cleanSummary(meta.title ?? `CommandCode session ${sessionId.slice(0, 8)}`, 80);

        sessions.push({
          id: sessionId,
          source: 'command-code',
          cwd,
          repo: extractRepo({ cwd }),
          branch,
          lines: stats.lines,
          bytes: stats.bytes,
          createdAt,
          updatedAt,
          originalPath: jsonlPath,
          summary,
          model: meta.model,
        });
      } catch (err) {
        logger.debug('command-code: failed to parse session', jsonlPath, err);
      }
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function extractCommandCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('default');
  const messages: ConversationMessage[] = [];
  const collector = new SummaryCollector(resolvedConfig);

  await scanJsonlFile(session.originalPath, (parsed) => {
    const rec = parsed as CommandCodeRecord;
    if (!rec.role || !Array.isArray(rec.content)) return 'continue';

    const timestamp = rec.timestamp ? new Date(rec.timestamp) : undefined;

    if (rec.role === 'user' || rec.role === 'assistant') {
      const text = joinTextBlocks(rec.content);
      if (text) {
        messages.push({ role: rec.role as 'user' | 'assistant', content: text, timestamp });
      }
    }

    for (const block of rec.content) {
      if (block.type !== 'tool-call' || !block.toolName) continue;
      const input = block.input ?? {};
      const toolName = block.toolName;

      if (toolName === 'shell_command' || toolName === 'execute_command' || toolName === 'run_command') {
        const command = (input.command ?? input.cmd ?? '') as string;
        if (command) {
          collector.add(toolName, shellSummary(command), { data: { category: 'shell', command } });
        }
      } else {
        const filePath = (input.path ?? input.file_path ?? input.filePath ?? '') as string;
        if (filePath) {
          const isWrite = /write|edit|patch|create/i.test(toolName);
          collector.add(toolName, fileSummary(isWrite ? 'edit' : 'read', filePath), {
            data: { category: isWrite ? 'edit' : 'read', filePath },
            filePath,
            isWrite,
          });
        }
      }
    }
    return 'continue';
  });

  const maxMessages = resolvedConfig.recentMessages ?? 10;
  const recentMessages = messages.slice(-maxMessages);
  const filesModified = collector.getFilesModified();
  const toolSummaries = collector.getSummaries();

  const markdown = generateHandoffMarkdown(session, recentMessages, filesModified, [], toolSummaries);

  return {
    session,
    recentMessages,
    filesModified,
    pendingTasks: [],
    toolSummaries,
    markdown,
  };
}

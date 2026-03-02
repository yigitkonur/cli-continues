import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  ToolUsageSummary,
  UnifiedSession,
} from '../types/index.js';
import { classifyToolName } from '../types/tool-names.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';
import { fileSummary, mcpSummary, SummaryCollector, shellSummary, truncate } from '../utils/tool-summarizer.js';

const qwenHome = process.env.QWEN_HOME || homeDir();
const QWEN_BASE_DIR = path.join(qwenHome, '.qwen', 'tmp');

// ── ChatRecord types ────────────────────────────────────────────────────────
// Matches QwenLM/qwen-code ChatRecord interface from chatRecordingService.ts

interface QwenPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { output?: string } };
}

interface QwenContent {
  role?: string;
  parts?: QwenPart[];
}

interface QwenToolCallResult {
  displayName?: string;
  status?: string;
  resultDisplay?: {
    filePath?: string;
    fileDiff?: string;
    diffStat?: { model_added_lines?: number; model_removed_lines?: number };
    isNewFile?: boolean;
    type?: string;
  };
}

interface QwenUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface QwenChatRecord {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  subtype?: string;
  cwd: string;
  version?: string;
  gitBranch?: string;
  message?: QwenContent;
  usageMetadata?: QwenUsageMetadata;
  model?: string;
  toolCallResult?: QwenToolCallResult;
}

// ── JSONL reading ───────────────────────────────────────────────────────────

async function readJsonlRecords(filePath: string): Promise<QwenChatRecord[]> {
  const records: QwenChatRecord[] = [];
  const input = fs.createReadStream(filePath, 'utf8');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as QwenChatRecord);
    } catch {
      logger.debug('qwen-code: skipping malformed JSONL line in', filePath);
    }
  }

  return records;
}

// ── Text extraction ─────────────────────────────────────────────────────────

function extractTextFromParts(parts: QwenPart[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter((p) => p.text)
    .map((p) => p.text!)
    .join('\n');
}

function extractContentText(content: QwenContent | undefined): string {
  if (!content?.parts) return '';
  return extractTextFromParts(content.parts);
}

// ── Session file discovery ──────────────────────────────────────────────────

async function findSessionFiles(): Promise<string[]> {
  const results: string[] = [];

  if (!fs.existsSync(QWEN_BASE_DIR)) return results;

  for (const projectDir of listSubdirectories(QWEN_BASE_DIR)) {
    if (path.basename(projectDir) === 'bin') continue;
    const chatsDir = path.join(projectDir, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    try {
      const entries = fs.readdirSync(chatsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          results.push(path.join(chatsDir, entry.name));
        }
      }
    } catch (err) {
      logger.debug('qwen-code: error reading chats dir', chatsDir, err);
    }
  }

  return results;
}

// ── Session metadata extraction ─────────────────────────────────────────────

async function extractSessionMeta(filePath: string): Promise<{
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  firstUserMessage: string;
  firstTimestamp: string;
  lastTimestamp: string;
  model?: string;
  lineCount: number;
} | null> {
  const input = fs.createReadStream(filePath, 'utf8');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let sessionId = '';
  let cwd = '';
  let gitBranch: string | undefined;
  let firstUserMessage = '';
  let firstTimestamp = '';
  let lastTimestamp = '';
  let model: string | undefined;
  let lineCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;

    try {
      const record = JSON.parse(line) as QwenChatRecord;

      if (!sessionId && record.sessionId) sessionId = record.sessionId;
      if (!cwd && record.cwd) cwd = record.cwd;
      if (!gitBranch && record.gitBranch) gitBranch = record.gitBranch;
      if (!model && record.model) model = record.model;

      if (!firstTimestamp && record.timestamp) firstTimestamp = record.timestamp;
      if (record.timestamp) lastTimestamp = record.timestamp;

      if (!firstUserMessage && record.type === 'user') {
        firstUserMessage = extractContentText(record.message);
      }
    } catch {
      // skip malformed line
    }
  }

  if (!sessionId) return null;

  return { sessionId, cwd, gitBranch, firstUserMessage, firstTimestamp, lastTimestamp, model, lineCount };
}

// ── Tool data extraction ────────────────────────────────────────────────────

function extractToolData(
  records: QwenChatRecord[],
  config?: VerbosityConfig,
): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector(config);

  for (const record of records) {
    // Extract from functionCall parts in assistant messages
    if (record.type === 'assistant' && record.message?.parts) {
      for (const part of record.message.parts) {
        if (!part.functionCall) continue;
        const { name, args } = part.functionCall;
        const category = classifyToolName(name);
        if (!category) continue;

        const fp = (args?.file_path as string) || (args?.path as string) || '';

        switch (category) {
          case 'shell': {
            const cmd = (args?.command as string) || (args?.cmd as string) || '';
            collector.add(name, shellSummary(cmd), { data: { category: 'shell', command: cmd } });
            break;
          }
          case 'write':
            collector.add(name, fileSummary('write', fp), {
              data: { category: 'write', filePath: fp },
              filePath: fp,
              isWrite: true,
            });
            break;
          case 'read':
            collector.add(name, fileSummary('read', fp), {
              data: { category: 'read', filePath: fp },
              filePath: fp,
            });
            break;
          case 'edit':
            collector.add(name, fileSummary('edit', fp), {
              data: { category: 'edit', filePath: fp },
              filePath: fp,
              isWrite: true,
            });
            break;
          case 'grep': {
            const pattern = (args?.pattern as string) || (args?.query as string) || '';
            collector.add(name, `grep "${truncate(pattern, 40)}"`, { data: { category: 'grep', pattern } });
            break;
          }
          case 'glob': {
            const pattern = (args?.pattern as string) || fp;
            collector.add(name, `glob ${truncate(pattern, 50)}`, { data: { category: 'glob', pattern } });
            break;
          }
          case 'search':
            collector.add(name, `search "${truncate((args?.query as string) || '', 50)}"`, {
              data: { category: 'search', query: (args?.query as string) || '' },
            });
            break;
          case 'fetch':
            collector.add(name, `fetch ${truncate((args?.url as string) || '', 60)}`, {
              data: { category: 'fetch', url: (args?.url as string) || '' },
            });
            break;
          case 'task': {
            const desc = (args?.description as string) || (args?.prompt as string) || '';
            collector.add(name, `task "${truncate(desc, 60)}"`, { data: { category: 'task', description: desc } });
            break;
          }
          case 'ask': {
            const question = truncate((args?.question as string) || '', 80);
            collector.add(name, `ask: "${question}"`, { data: { category: 'ask', question } });
            break;
          }
          default: {
            const argsStr = args ? JSON.stringify(args).slice(0, 100) : '';
            collector.add(name, mcpSummary(name, argsStr), { data: { category: 'mcp', toolName: name } });
          }
        }
      }
    }

    // Extract from tool_result records with enriched metadata
    if (record.type === 'tool_result' && record.toolCallResult) {
      const tcr = record.toolCallResult;
      const displayName = tcr.displayName || '';
      const fp = tcr.resultDisplay?.filePath || '';

      if (displayName && fp && tcr.resultDisplay?.fileDiff) {
        let diffStat: { added: number; removed: number } | undefined;
        if (tcr.resultDisplay.diffStat) {
          diffStat = {
            added: tcr.resultDisplay.diffStat.model_added_lines || 0,
            removed: tcr.resultDisplay.diffStat.model_removed_lines || 0,
          };
        }
        const isNew = tcr.resultDisplay.isNewFile ?? false;
        collector.add(displayName, fileSummary(isNew ? 'write' : 'edit', fp, diffStat, isNew), {
          data: { category: isNew ? 'write' : 'edit', filePath: fp },
          filePath: fp,
          isWrite: true,
        });
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

// ── Session notes extraction ────────────────────────────────────────────────

function extractSessionNotes(records: QwenChatRecord[]): SessionNotes {
  const notes: SessionNotes = {};

  for (const record of records) {
    if (record.type !== 'assistant') continue;

    if (record.model && !notes.model) notes.model = record.model;

    if (record.usageMetadata) {
      if (!notes.tokenUsage) notes.tokenUsage = { input: 0, output: 0 };
      notes.tokenUsage.input += record.usageMetadata.promptTokenCount || 0;
      notes.tokenUsage.output += record.usageMetadata.candidatesTokenCount || 0;

      if (record.usageMetadata.cachedContentTokenCount) {
        if (!notes.cacheTokens) notes.cacheTokens = { creation: 0, read: 0 };
        notes.cacheTokens.read += record.usageMetadata.cachedContentTokenCount;
      }
      if (record.usageMetadata.thoughtsTokenCount) {
        notes.thinkingTokens = (notes.thinkingTokens || 0) + record.usageMetadata.thoughtsTokenCount;
      }
    }
  }

  return notes;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function parseQwenCodeSessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const meta = await extractSessionMeta(filePath);
      if (!meta) continue;

      const fileStats = fs.statSync(filePath);

      sessions.push({
        id: meta.sessionId,
        source: 'qwen-code',
        cwd: meta.cwd,
        repo: '',
        branch: meta.gitBranch,
        lines: meta.lineCount,
        bytes: fileStats.size,
        createdAt: new Date(meta.firstTimestamp),
        updatedAt: new Date(meta.lastTimestamp),
        originalPath: filePath,
        summary: cleanSummary(meta.firstUserMessage) || undefined,
        model: meta.model,
      });
    } catch (err) {
      logger.debug('qwen-code: skipping unparseable session', filePath, err);
    }
  }

  return sessions
    .filter((s) => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function extractQwenCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const records = await readJsonlRecords(session.originalPath);
  const recentMessages: ConversationMessage[] = [];
  const pendingTasks: string[] = [];

  const toolData = extractToolData(records, resolvedConfig);
  const sessionNotes = extractSessionNotes(records);

  // Extract recent messages (last N user/assistant records)
  const messageRecords = records.filter((r) => r.type === 'user' || r.type === 'assistant');
  for (const record of messageRecords.slice(-resolvedConfig.recentMessages * 2)) {
    const text = extractContentText(record.message);
    if (!text) continue;

    recentMessages.push({
      role: record.type === 'user' ? 'user' : 'assistant',
      content: text,
      timestamp: new Date(record.timestamp),
    });
  }

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    toolData.filesModified,
    pendingTasks,
    toolData.summaries,
    sessionNotes,
    resolvedConfig,
  );

  return {
    session: sessionNotes?.model ? { ...session, model: sessionNotes.model } : session,
    recentMessages: trimmed,
    filesModified: toolData.filesModified,
    pendingTasks,
    toolSummaries: toolData.summaries,
    sessionNotes,
    markdown,
  };
}

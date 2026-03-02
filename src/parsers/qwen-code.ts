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
import { QwenChatRecordSchema } from '../types/schemas.js';
import type { QwenChatRecord, QwenContent, QwenFileDiff, QwenPart } from '../types/schemas.js';
import { classifyToolName } from '../types/tool-names.js';
import { listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { fileSummary, mcpSummary, SummaryCollector, shellSummary, truncate } from '../utils/tool-summarizer.js';

const qwenHome = process.env.QWEN_HOME || homeDir();
// Qwen Code stores chats under ~/.qwen/projects/<sanitized-cwd>/chats/
// sanitizeCwd replaces all non-alphanumeric chars with '-'
const QWEN_PROJECTS_DIR = path.join(qwenHome, '.qwen', 'projects');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Type guard: is resultDisplay a FileDiff object (not a string or todo)? */
function isFileDiff(rd: unknown): rd is QwenFileDiff {
  if (!rd || typeof rd !== 'object') return false;
  return 'fileName' in rd || 'fileDiff' in rd;
}

/** Parse a timestamp string defensively, falling back to a given Date */
function parseTimestamp(ts: string, fallback: Date): Date {
  if (!ts) return fallback;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

// ── JSONL reading ───────────────────────────────────────────────────────────

async function readJsonlRecords(filePath: string): Promise<QwenChatRecord[]> {
  const records: QwenChatRecord[] = [];
  const input = fs.createReadStream(filePath, 'utf8');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = QwenChatRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      logger.debug('qwen-code: skipping malformed JSONL line in', filePath);
    }
  }

  return records;
}

// ── Text extraction ─────────────────────────────────────────────────────────

/** Extract non-thought text from parts */
function extractTextFromParts(parts: QwenPart[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text!)
    .join('\n');
}

/** Extract thought/reasoning text from parts */
function extractThoughtsFromParts(parts: QwenPart[] | undefined): string[] {
  if (!parts) return [];
  return parts.filter((p) => p.text && p.thought).map((p) => p.text!);
}

function extractContentText(content: QwenContent | undefined): string {
  if (!content?.parts) return '';
  return extractTextFromParts(content.parts);
}

// ── Session file discovery ──────────────────────────────────────────────────

async function findSessionFiles(): Promise<string[]> {
  const results: string[] = [];

  if (!fs.existsSync(QWEN_PROJECTS_DIR)) return results;

  for (const projectDir of listSubdirectories(QWEN_PROJECTS_DIR)) {
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
      const parsed = QwenChatRecordSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const record = parsed.data;

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
  const processedCallUuids = new Set<string>();

  for (const record of records) {
    // Extract from functionCall parts in assistant messages
    if (record.type === 'assistant' && record.message?.parts) {
      const hasFunctionCalls = record.message.parts.some((p: QwenPart) => p.functionCall);
      if (hasFunctionCalls) processedCallUuids.add(record.uuid);
      for (const part of record.message.parts) {
        if (!part.functionCall) continue;
        const { name, args } = part.functionCall;
        const category = classifyToolName(name);
        if (!category) continue;

        const fp = (args?.file_path as string) || (args?.path as string) || '';

        // Try to extract result from a matching functionResponse in the same parts array
        let resultStr: string | undefined;
        for (const rp of record.message.parts) {
          if (rp.functionResponse?.name === name && rp.functionResponse.response?.output) {
            resultStr = String(rp.functionResponse.response.output);
            break;
          }
        }
        const isResponseError = record.message.parts.some(
          (rp: QwenPart) => rp.functionResponse?.name === name && rp.functionResponse.response?.status === 'error',
        );

        switch (category) {
          case 'shell': {
            const cmd = (args?.command as string) || (args?.cmd as string) || '';
            collector.add(name, shellSummary(cmd, resultStr), {
              data: { category: 'shell', command: cmd, ...(resultStr ? { stdoutTail: resultStr.slice(-500) } : {}) },
              isError: isResponseError,
            });
            break;
          }
          case 'write': {
            collector.add(name, fileSummary('write', fp), {
              data: { category: 'write', filePath: fp },
              filePath: fp,
              isWrite: true,
              isError: isResponseError,
            });
            break;
          }
          case 'read':
            collector.add(name, fileSummary('read', fp), {
              data: { category: 'read', filePath: fp },
              filePath: fp,
              isError: isResponseError,
            });
            break;
          case 'edit':
            collector.add(name, fileSummary('edit', fp), {
              data: { category: 'edit', filePath: fp },
              filePath: fp,
              isWrite: true,
              isError: isResponseError,
            });
            break;
          case 'grep': {
            const pattern = (args?.pattern as string) || (args?.query as string) || '';
            collector.add(name, `grep "${truncate(pattern, 40)}"`, {
              data: { category: 'grep', pattern, ...(fp ? { targetPath: fp } : {}) },
              isError: isResponseError,
            });
            break;
          }
          case 'glob': {
            const pattern = (args?.pattern as string) || fp;
            collector.add(name, `glob ${truncate(pattern, 50)}`, {
              data: { category: 'glob', pattern },
              isError: isResponseError,
            });
            break;
          }
          case 'search':
            collector.add(name, `search "${truncate((args?.query as string) || '', 50)}"`, {
              data: { category: 'search', query: (args?.query as string) || '' },
              isError: isResponseError,
            });
            break;
          case 'fetch': {
            const url = (args?.url as string) || '';
            collector.add(name, `fetch ${truncate(url, 60)}`, {
              data: {
                category: 'fetch',
                url,
                ...(resultStr ? { resultPreview: resultStr.slice(0, 100) } : {}),
              },
              isError: isResponseError,
            });
            break;
          }
          case 'task': {
            const desc = (args?.description as string) || (args?.prompt as string) || '';
            const agentType = (args?.subagent_type as string) || undefined;
            collector.add(name, `task "${truncate(desc, 60)}"${agentType ? ` (${agentType})` : ''}`, {
              data: { category: 'task', description: desc, ...(agentType ? { agentType } : {}) },
              isError: isResponseError,
            });
            break;
          }
          case 'ask': {
            const question = truncate((args?.question as string) || (args?.prompt as string) || '', 80);
            collector.add(name, `ask: "${question}"`, {
              data: { category: 'ask', question },
              isError: isResponseError,
            });
            break;
          }
          default: {
            const argsStr = args ? JSON.stringify(args).slice(0, 100) : '';
            collector.add(name, mcpSummary(name, argsStr, resultStr), {
              data: {
                category: 'mcp',
                toolName: name,
                ...(argsStr ? { params: argsStr } : {}),
                ...(resultStr ? { result: resultStr.slice(0, 100) } : {}),
              },
              isError: isResponseError,
            });
          }
        }
      }
    }

    // Extract from tool_result records (skip if parent already processed via functionCall)
    if (record.type === 'tool_result' && record.toolCallResult) {
      if (record.parentUuid && processedCallUuids.has(record.parentUuid)) continue;
      const tcr = record.toolCallResult;
      const displayName = tcr.displayName || '';
      const isError = tcr.status ? !['ok', 'success', 'completed'].includes(tcr.status.toLowerCase()) : false;

      if (displayName && isFileDiff(tcr.resultDisplay)) {
        const rd = tcr.resultDisplay;
        const fp = rd.fileName || '';

        let diffStat: { added: number; removed: number } | undefined;
        if (rd.diffStat) {
          diffStat = {
            added: rd.diffStat.model_added_lines || 0,
            removed: rd.diffStat.model_removed_lines || 0,
          };
        } else if (rd.fileDiff) {
          // Fallback: count +/- lines from fileDiff
          const lines = rd.fileDiff.split('\n');
          diffStat = {
            added: lines.filter((l: string) => l.startsWith('+')).length,
            removed: lines.filter((l: string) => l.startsWith('-')).length,
          };
        }

        // isNewFile is determined by originalContent === null
        const isNew = rd.originalContent === null;
        const diff = rd.fileDiff || undefined;
        collector.add(displayName, fileSummary(isNew ? 'write' : 'edit', fp, diffStat, isNew), {
          data: {
            category: isNew ? 'write' : 'edit',
            filePath: fp,
            isNewFile: isNew,
            ...(diff ? { diff } : {}),
            ...(diffStat ? { diffStats: diffStat } : {}),
          },
          filePath: fp,
          isWrite: true,
          isError,
        });
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

// ── Session notes extraction ────────────────────────────────────────────────

function extractSessionNotes(records: QwenChatRecord[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  for (const record of records) {
    if (record.type !== 'assistant') continue;

    if (record.model && !notes.model) notes.model = record.model;

    // Extract reasoning from thought parts
    if (record.message?.parts && reasoning.length < 5) {
      for (const thought of extractThoughtsFromParts(record.message.parts)) {
        if (reasoning.length >= 5) break;
        if (thought.length > 10) reasoning.push(truncate(thought, 200));
      }
    }

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

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Reconstruct main conversation path by walking from latest leaf back via parentUuid */
function reconstructMainPath(records: QwenChatRecord[]): QwenChatRecord[] {
  if (records.length === 0) return [];

  const byUuid = new Map<string, QwenChatRecord>();
  const parentUuids = new Set<string>();

  for (const r of records) {
    byUuid.set(r.uuid, r);
    if (r.parentUuid) parentUuids.add(r.parentUuid);
  }

  // Find the latest leaf (record with no children, latest timestamp)
  let latestLeaf = records[records.length - 1];
  let latestTime = 0;
  for (const r of records) {
    if (!parentUuids.has(r.uuid)) {
      const t = new Date(r.timestamp).getTime();
      if (!Number.isNaN(t) && t > latestTime) {
        latestTime = t;
        latestLeaf = r;
      }
    }
  }

  // Walk back from leaf to root via parentUuid
  const pathResult: QwenChatRecord[] = [];
  let current: QwenChatRecord | undefined = latestLeaf;
  while (current) {
    pathResult.unshift(current);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }

  return pathResult;
}

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
        repo: extractRepoFromCwd(meta.cwd),
        branch: meta.gitBranch,
        lines: meta.lineCount,
        bytes: fileStats.size,
        createdAt: parseTimestamp(meta.firstTimestamp, fileStats.mtime),
        updatedAt: parseTimestamp(meta.lastTimestamp, fileStats.mtime),
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

  // Extract recent messages and pending tasks from main conversation path
  const mainPath = reconstructMainPath(records);
  const messageRecords = mainPath.filter((r) => r.type === 'user' || r.type === 'assistant');
  for (const record of messageRecords.slice(-resolvedConfig.recentMessages * 2)) {
    // Extract pending tasks from thought parts
    if (record.type === 'assistant' && record.message?.parts && pendingTasks.length < 5) {
      for (const thought of extractThoughtsFromParts(record.message.parts)) {
        if (pendingTasks.length >= 5) break;
        const lower = thought.toLowerCase();
        if (
          lower.includes('todo') ||
          lower.includes('next') ||
          lower.includes('remaining') ||
          lower.includes('need to') ||
          lower.includes('next step')
        ) {
          pendingTasks.push(truncate(thought, 200));
        }
      }
    }

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

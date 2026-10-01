import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  SessionParseOptions,
  StructuredToolSample,
  ToolCall,
  UnifiedSession,
} from '../types/index.js';
import { classifyToolName } from '../types/tool-names.js';
import { cleanUserQueryText } from '../utils/content.js';
import { scanJsonlLines } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepo, homeDir, trimMessages } from '../utils/parser-helpers.js';
import { matchesCwd } from '../utils/slug.js';
import {
  fetchSummary,
  fileSummary,
  globSummary,
  grepSummary,
  mcpSummary,
  type SummaryCollector,
  searchSummary,
  shellSummary,
  SummaryCollector as ToolSummaryCollector,
  truncate,
} from '../utils/tool-summarizer.js';

/**
 * Grok Build sessions live at `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`.
 * The group directory is the URL-encoded working directory. When that name
 * would exceed 255 bytes, Grok stores a slug and writes the real path to `.cwd`.
 * `updates.jsonl` is the ACP conversation log. A `rewind_marker` drops numbered
 * prompts at and after `target_prompt_index`. `chat_history.jsonl` is the
 * fallback raw model transcript. `summary.json` is the index entry.
 */

const TRANSCRIPT_FILES = ['updates.jsonl', 'chat_history.jsonl'] as const;
const SESSION_MARKERS = ['summary.json', ...TRANSCRIPT_FILES] as const;

interface GrokToolDraft {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  success?: boolean;
  filePath?: string;
}

interface AssistantDraft {
  parts: string[];
  tools: GrokToolDraft[];
  timestamp?: Date;
}

interface TranscriptRead {
  messages: ConversationMessage[];
  pendingTasks: string[];
  collector: SummaryCollector;
  notes: SessionNotes;
  droppedLines: number;
  sourceFile: string;
  sawPlanEvent: boolean;
}

interface PromptScoped<T> {
  promptIndex: number | null;
  value: T;
}

function grokHome(): string {
  const configured = process.env.GROK_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir(), '.grok');
}

function sessionsRoot(): string {
  return path.join(grokHome(), 'sessions');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseIso(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function eventDate(record: Record<string, unknown>): Date | undefined {
  const timestamp = record.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const millis = timestamp > 1e12 ? timestamp : timestamp * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return parseIso(timestamp);
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  return path.resolve(trimmed);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    logger.debug('grok: failed to read file', filePath, err);
    return undefined;
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(filePath);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch (err) {
    logger.debug('grok: failed to parse json', filePath, err);
    return undefined;
  }
}

async function isDirectory(fullPath: string, dirent?: fs.Dirent): Promise<boolean> {
  if (dirent?.isDirectory()) return true;
  if (dirent && !dirent.isSymbolicLink()) return false;
  try {
    const stat = await fs.promises.stat(fullPath);
    return stat.isDirectory();
  } catch (err) {
    logger.debug('grok: cannot stat directory', fullPath, err);
    return false;
  }
}

async function listSubdirectories(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    logger.debug('grok: cannot list directory', dir, err);
    return [];
  }

  const subdirs: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (await isDirectory(fullPath, entry)) subdirs.push(fullPath);
  }
  return subdirs;
}

async function cwdFromGroup(groupPath: string, groupName: string): Promise<string> {
  const cwdFile = path.join(groupPath, '.cwd');
  if (await pathExists(cwdFile)) {
    const text = await readText(cwdFile);
    const fromFile = text?.split('\n')[0]?.trim();
    if (fromFile) return normalizeCwd(fromFile);
  }

  try {
    const decoded = decodeURIComponent(groupName);
    if (decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded)) return normalizeCwd(decoded);
  } catch (err) {
    logger.debug('grok: cwd directory name is not URL-encoded', groupName, err);
  }
  return '';
}

async function isSessionDir(dir: string): Promise<boolean> {
  for (const name of SESSION_MARKERS) {
    if (await pathExists(path.join(dir, name))) return true;
  }
  return false;
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    logger.debug('grok: tool arguments were not JSON', err);
    return {};
  }
}

function toolMeta(update: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = update._meta;
  if (!isRecord(meta)) return undefined;
  const tool = meta['x.ai/tool'];
  return isRecord(tool) ? tool : undefined;
}

function canonicalToolName(update: Record<string, unknown>, args: Record<string, unknown>): string {
  const metaName = stringField(toolMeta(update), 'name');
  if (metaName) return metaName;

  const variant = stringField(args, 'variant');
  if (variant === 'WebSearch') return 'web_search';
  if (variant === 'XSearch') return 'x_keyword_search';

  const title = stringField(update, 'title');
  if (!title) return 'tool';
  if (title.startsWith('Web search')) return 'web_search';
  if (title.startsWith('X search')) return 'x_keyword_search';
  if (!title.includes(' ') && !title.endsWith(':')) return title;
  return title.replace(/:$/, '').trim() || 'tool';
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function filePathFromArgs(args: Record<string, unknown>): string | undefined {
  return stringArg(args, 'target_file', 'file_path', 'path', 'target_directory');
}

function pathsFromLocations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const itemPath = stringField(item, 'path');
    if (itemPath) paths.push(itemPath);
  }
  return paths;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (!isRecord(item)) continue;
    if (typeof item.text === 'string') parts.push(item.text);
    const inner = item.content;
    if (isRecord(inner) && typeof inner.text === 'string') parts.push(inner.text);
  }
  return parts.join('\n');
}

function terminalStatus(value: unknown): 'completed' | 'failed' | undefined {
  const raw =
    typeof value === 'string' ? value : isRecord(value) && typeof value.status === 'string' ? value.status : '';
  const normalized = raw.toLowerCase();
  if (normalized === 'completed' || normalized === 'success' || normalized === 'ok') return 'completed';
  if (normalized === 'failed' || normalized === 'error' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'failed';
  }
  return undefined;
}

function planTasksFromEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const tasks: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const status = stringField(entry, 'status')?.toLowerCase();
    if (status === 'completed' || status === 'cancelled' || status === 'canceled') continue;
    const content = stringField(entry, 'content');
    if (content) tasks.push(content);
  }
  return tasks;
}

function planTasksFromFile(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  if (Array.isArray(record.entries)) return planTasksFromEntries(record.entries);
  const todos = record.todos;
  if (Array.isArray(todos)) return planTasksFromEntries(todos);
  if (!isRecord(todos)) return [];
  return planTasksFromEntries(Object.values(todos));
}

function sessionUpdateOf(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof record.sessionUpdate === 'string') return record;
  const params = record.params;
  if (!isRecord(params)) return undefined;
  const update = params.update;
  return isRecord(update) && typeof update.sessionUpdate === 'string' ? update : undefined;
}

function nonNegativeInt(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = numberField(record, key);
  if (value === undefined || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/** User prompts carry `_meta.promptIndex`. Shell-only chunks omit it. */
function promptIndexOf(update: Record<string, unknown>): number | undefined {
  return nonNegativeInt(isRecord(update._meta) ? update._meta : undefined, 'promptIndex');
}

function rewindTargetOf(update: Record<string, unknown>): number | undefined {
  return nonNegativeInt(update, 'target_prompt_index');
}

function appendPart(parts: string[], text: string): void {
  const trimmed = text.trim();
  if (trimmed) parts.push(trimmed);
}

function flushUser(messages: ConversationMessage[], parts: string[], timestamp?: Date): void {
  if (parts.length === 0) return;
  messages.push({
    role: 'user',
    content: parts.join('\n\n'),
    timestamp,
  });
  parts.length = 0;
}

function flushAssistant(
  messages: ConversationMessage[],
  draft: AssistantDraft | undefined,
  collector?: SummaryCollector,
): AssistantDraft | undefined {
  if (!draft) return undefined;
  const content = draft.parts.join('\n\n').trim();
  const toolCalls: ToolCall[] = draft.tools.map((tool) => ({
    name: tool.name,
    id: tool.id,
    arguments: tool.args,
    result: tool.result,
    success: tool.success,
  }));
  if (collector) {
    for (const tool of draft.tools) recordToolUse(collector, tool);
  }
  if (content || toolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content,
      timestamp: draft.timestamp,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
  return undefined;
}

function ensureAssistant(draft: AssistantDraft | undefined, timestamp?: Date): AssistantDraft {
  if (draft) {
    if (!draft.timestamp && timestamp) draft.timestamp = timestamp;
    return draft;
  }
  return { parts: [], tools: [], timestamp };
}

function upsertTool(draft: AssistantDraft, id: string): GrokToolDraft {
  const existing = draft.tools.find((tool) => tool.id === id);
  if (existing) return existing;
  const created: GrokToolDraft = { id, name: 'tool', args: {} };
  draft.tools.push(created);
  return created;
}

function applyToolFields(tool: GrokToolDraft, update: Record<string, unknown>): void {
  const args = parseArgs(update.rawInput);
  const name = canonicalToolName(update, args);
  if (tool.name === 'tool' && name !== 'tool') tool.name = name;
  for (const [key, value] of Object.entries(args)) {
    if (!(key in tool.args)) tool.args[key] = value;
  }

  const located = pathsFromLocations(update.locations)[0];
  if (!tool.filePath) tool.filePath = filePathFromArgs(tool.args) || located;

  const resultText = textFromContent(update.content).trim();
  if (resultText) tool.result = truncate(resultText, 500);

  const status = terminalStatus(update.status);
  if (status === 'completed') tool.success = true;
  if (status === 'failed') tool.success = false;
}

function questionText(args: Record<string, unknown>): string {
  const questions = args.questions;
  if (typeof questions === 'string') return questions;
  if (!Array.isArray(questions)) return 'question';
  for (const question of questions) {
    if (typeof question === 'string' && question.trim()) return question.trim();
    if (isRecord(question)) {
      const text = stringField(question, 'question') || stringField(question, 'text');
      if (text) return text;
    }
  }
  return 'question';
}

function recordToolUse(collector: SummaryCollector, tool: GrokToolDraft): void {
  const category = classifyToolName(tool.name);
  if (!category) return;

  const filePath = tool.filePath || filePathFromArgs(tool.args);
  const isError = tool.success === false;
  const result = tool.result;

  switch (category) {
    case 'shell': {
      const command = stringArg(tool.args, 'command') || '';
      collector.add(tool.name, shellSummary(command, result), {
        isError,
        data: { category: 'shell', command, errored: isError || undefined, errorMessage: isError ? result : undefined },
      });
      return;
    }
    case 'read': {
      if (!filePath) break;
      collector.add(tool.name, fileSummary('read', filePath), {
        isError,
        filePath,
        data: { category: 'read', filePath },
      });
      return;
    }
    case 'write': {
      if (!filePath) break;
      collector.add(tool.name, fileSummary('write', filePath), {
        isError,
        filePath,
        isWrite: true,
        data: { category: 'write', filePath },
      });
      return;
    }
    case 'edit': {
      if (!filePath) break;
      collector.add(tool.name, fileSummary('edit', filePath), {
        isError,
        filePath,
        isWrite: true,
        data: { category: 'edit', filePath },
      });
      return;
    }
    case 'grep': {
      const pattern = stringArg(tool.args, 'pattern') || '';
      const targetPath = stringArg(tool.args, 'path', 'glob');
      collector.add(tool.name, grepSummary(pattern, targetPath), {
        isError,
        data: { category: 'grep', pattern, targetPath },
      });
      return;
    }
    case 'glob': {
      const pattern = stringArg(tool.args, 'target_directory', 'pattern', 'glob') || filePath || '.';
      collector.add(tool.name, globSummary(pattern), {
        isError,
        data: { category: 'glob', pattern },
      });
      return;
    }
    case 'search': {
      const query = stringArg(tool.args, 'query', 'pattern') || stringArg(tool.args, 'variant') || tool.name;
      collector.add(tool.name, searchSummary(query), {
        isError,
        data: { category: 'search', query },
      });
      return;
    }
    case 'fetch': {
      const url = stringArg(tool.args, 'url') || '';
      collector.add(tool.name, fetchSummary(url), {
        isError,
        data: { category: 'fetch', url },
      });
      return;
    }
    case 'task': {
      const description = stringArg(tool.args, 'description', 'prompt') || tool.name;
      const data: StructuredToolSample = { category: 'task', description: truncate(description, 100) };
      collector.add(tool.name, `task "${truncate(description, 60)}"`, { isError, data });
      return;
    }
    case 'ask': {
      const question = truncate(questionText(tool.args), 80);
      collector.add(tool.name, `ask: "${question}"`, {
        isError,
        data: { category: 'ask', question },
      });
      return;
    }
    default: {
      const argsPreview = truncate(JSON.stringify(tool.args), 80);
      collector.add(tool.name, mcpSummary(tool.name, argsPreview, result), {
        isError,
        data: {
          category: 'mcp',
          toolName: tool.name,
          params: argsPreview,
          result: result ? truncate(result, 100) : undefined,
        },
      });
    }
  }
}

function captureUsage(notes: SessionNotes, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  const input = numberField(usage, 'inputTokens');
  const output = numberField(usage, 'outputTokens');
  if (input !== undefined || output !== undefined) {
    notes.tokenUsage = { input: input ?? 0, output: output ?? 0 };
  }
  const cacheRead = numberField(usage, 'cachedReadTokens');
  const cacheCreation = numberField(usage, 'cacheCreationTokens');
  if (cacheRead !== undefined || cacheCreation !== undefined) {
    notes.cacheTokens = { read: cacheRead ?? 0, creation: cacheCreation ?? 0 };
  }
  const thinking = numberField(usage, 'reasoningTokens');
  if (thinking !== undefined) notes.thinkingTokens = thinking;
  const model = stringField(usage, 'primaryModelId');
  if (model) notes.model = model;
}

function isLivePrompt(promptIndex: number | null, target: number): boolean {
  return promptIndex === null || promptIndex < target;
}

async function readUpdates(filePath: string, config: VerbosityConfig): Promise<TranscriptRead> {
  const storedMessages: Array<PromptScoped<ConversationMessage>> = [];
  const storedTools: Array<PromptScoped<GrokToolDraft>> = [];
  const storedReasoning: Array<PromptScoped<string>> = [];
  const planHistory: Array<PromptScoped<string[]>> = [];
  const elapsedSamples: Array<PromptScoped<number>> = [];
  const usageSamples: Array<PromptScoped<Record<string, unknown>>> = [];
  const userParts: string[] = [];
  let userTimestamp: Date | undefined;
  let assistant: AssistantDraft | undefined;
  let currentPromptIndex: number | null = null;
  let sawPlanEvent = false;
  let droppedLines = 0;
  let toolCounter = 0;

  // Tag each turn with the user prompt that produced it, then drop turns whose
  // promptIndex is >= target_prompt_index. That index is the next live prompt:
  // /rewind discards it and everything after it, and later events rebuild from there.
  // Chunks with no promptIndex (shell commands before the first prompt) stay.
  function commitUser(): void {
    const batch: ConversationMessage[] = [];
    flushUser(batch, userParts, userTimestamp);
    userTimestamp = undefined;
    for (const message of batch) storedMessages.push({ promptIndex: currentPromptIndex, value: message });
  }

  function commitAssistant(): void {
    if (!assistant) return;
    const tools = assistant.tools.slice();
    const batch: ConversationMessage[] = [];
    assistant = flushAssistant(batch, assistant);
    for (const message of batch) storedMessages.push({ promptIndex: currentPromptIndex, value: message });
    for (const tool of tools) storedTools.push({ promptIndex: currentPromptIndex, value: tool });
  }

  function rememberThought(text: string): void {
    if (storedReasoning.length >= 5) return;
    storedReasoning.push({ promptIndex: currentPromptIndex, value: truncate(text, 200) });
  }

  function applyRewind(target: number): void {
    commitUser();
    commitAssistant();
    const keep = <T>(items: Array<PromptScoped<T>>): Array<PromptScoped<T>> =>
      items.filter((item) => isLivePrompt(item.promptIndex, target));
    storedMessages.splice(0, storedMessages.length, ...keep(storedMessages));
    storedTools.splice(0, storedTools.length, ...keep(storedTools));
    storedReasoning.splice(0, storedReasoning.length, ...keep(storedReasoning));
    planHistory.splice(0, planHistory.length, ...keep(planHistory));
    elapsedSamples.splice(0, elapsedSamples.length, ...keep(elapsedSamples));
    usageSamples.splice(0, usageSamples.length, ...keep(usageSamples));
    if (currentPromptIndex !== null && currentPromptIndex >= target) currentPromptIndex = null;
  }

  await scanJsonlLines(filePath, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return 'continue';
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      droppedLines++;
      logger.debug('grok: skipping malformed updates.jsonl line', filePath, err);
      return 'continue';
    }
    if (!isRecord(parsed)) {
      droppedLines++;
      return 'continue';
    }

    const update = sessionUpdateOf(parsed);
    if (!update) return 'continue';
    const kind = stringField(update, 'sessionUpdate');
    const timestamp = eventDate(parsed);

    if (kind === 'rewind_marker') {
      const target = rewindTargetOf(update);
      if (target === undefined) return 'continue';
      applyRewind(target);
      return 'continue';
    }

    if (kind === 'user_message_chunk') {
      const incoming = promptIndexOf(update);
      if (incoming !== undefined && incoming !== currentPromptIndex) {
        commitAssistant();
        commitUser();
        currentPromptIndex = incoming;
      } else {
        commitAssistant();
      }
      appendPart(userParts, textFromContent(update.content));
      userTimestamp = userTimestamp || timestamp;
      return 'continue';
    }

    if (kind === 'agent_thought_chunk') {
      commitUser();
      const thought = textFromContent(update.content).trim();
      if (thought) rememberThought(thought);
      assistant = ensureAssistant(assistant, timestamp);
      return 'continue';
    }

    if (kind === 'agent_message_chunk') {
      commitUser();
      if (assistant && assistant.parts.length > 0 && assistant.tools.length > 0) {
        commitAssistant();
      }
      assistant = ensureAssistant(assistant, timestamp);
      appendPart(assistant.parts, textFromContent(update.content));
      return 'continue';
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      commitUser();
      assistant = ensureAssistant(assistant, timestamp);
      toolCounter += 1;
      const id = stringField(update, 'toolCallId') || `tool-${toolCounter}`;
      applyToolFields(upsertTool(assistant, id), update);
      return 'continue';
    }

    if (kind === 'plan') {
      sawPlanEvent = true;
      planHistory.push({ promptIndex: currentPromptIndex, value: planTasksFromEntries(update.entries) });
      return 'continue';
    }

    if (kind === 'turn_completed') {
      const elapsed = numberField(update, 'elapsed_ms');
      if (elapsed !== undefined && elapsed > 0) {
        elapsedSamples.push({ promptIndex: currentPromptIndex, value: elapsed });
      }
      if (isRecord(update.usage)) usageSamples.push({ promptIndex: currentPromptIndex, value: update.usage });
    }

    return 'continue';
  });

  commitUser();
  commitAssistant();

  const collector = new ToolSummaryCollector(config);
  for (const tool of storedTools) recordToolUse(collector, tool.value);

  const notes: SessionNotes = {};
  if (storedReasoning.length > 0) notes.reasoning = storedReasoning.map((item) => item.value);
  const activeTimeMs = elapsedSamples.reduce((sum, item) => sum + item.value, 0);
  if (activeTimeMs > 0) notes.activeTimeMs = activeTimeMs;
  const firstUsage = usageSamples[0];
  if (firstUsage) captureUsage(notes, firstUsage.value);

  const livePlan = planHistory[planHistory.length - 1];
  return {
    messages: storedMessages.map((item) => item.value),
    pendingTasks: livePlan?.value ?? [],
    collector,
    notes,
    droppedLines,
    sourceFile: filePath,
    sawPlanEvent,
  };
}

function chatToolResult(record: Record<string, unknown>): string {
  return truncate(textFromContent(record.content).trim(), 500);
}

async function readChatHistory(filePath: string, config: VerbosityConfig): Promise<TranscriptRead> {
  const messages: ConversationMessage[] = [];
  const toolsById = new Map<string, GrokToolDraft>();
  const reasoning: string[] = [];
  let droppedLines = 0;
  const collector = new ToolSummaryCollector(config);

  await scanJsonlLines(filePath, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return 'continue';
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      droppedLines++;
      logger.debug('grok: skipping malformed chat_history.jsonl line', filePath, err);
      return 'continue';
    }
    if (!isRecord(parsed)) {
      droppedLines++;
      return 'continue';
    }

    const type = stringField(parsed, 'type');
    if (type === 'system' || parsed.synthetic_reason) return 'continue';

    if (type === 'user') {
      const content = cleanUserQueryText(textFromContent(parsed.content)).trim();
      if (!content || content.startsWith('<system-reminder>') || content.startsWith('<user_info>')) return 'continue';
      messages.push({ role: 'user', content });
      return 'continue';
    }

    if (type === 'reasoning') {
      const summary = parsed.summary;
      if (Array.isArray(summary)) {
        for (const item of summary) {
          if (!isRecord(item)) continue;
          const text = stringField(item, 'text');
          if (text && reasoning.length < 5) reasoning.push(truncate(text, 200));
        }
      }
      return 'continue';
    }

    if (type === 'assistant') {
      const content = textFromContent(parsed.content).trim();
      const toolCalls: ToolCall[] = [];
      if (Array.isArray(parsed.tool_calls)) {
        for (const call of parsed.tool_calls) {
          if (!isRecord(call)) continue;
          const args = parseArgs(call.arguments);
          const name = stringField(call, 'name') || canonicalToolName(call, args);
          const id = stringField(call, 'id') || `${name}-${toolCalls.length}`;
          const draft: GrokToolDraft = { id, name, args, filePath: filePathFromArgs(args) };
          toolsById.set(id, draft);
          toolCalls.push({ name, id, arguments: args });
        }
      }
      if (content || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
      return 'continue';
    }

    if (type === 'tool_result') {
      const id = stringField(parsed, 'tool_call_id');
      const draft = id ? toolsById.get(id) : undefined;
      const result = chatToolResult(parsed);
      if (draft && result) draft.result = result;
      if (id) {
        for (const message of messages) {
          const match = message.toolCalls?.find((toolCall) => toolCall.id === id);
          if (match && result) match.result = result;
        }
      }
    }

    return 'continue';
  });

  for (const draft of toolsById.values()) recordToolUse(collector, draft);

  const notes: SessionNotes = {};
  if (reasoning.length > 0) notes.reasoning = reasoning;
  return {
    messages,
    pendingTasks: [],
    collector,
    notes,
    droppedLines,
    sourceFile: filePath,
    sawPlanEvent: false,
  };
}

async function readTranscript(sessionDir: string, config: VerbosityConfig): Promise<TranscriptRead | undefined> {
  const updatesPath = path.join(sessionDir, 'updates.jsonl');
  if (await pathExists(updatesPath)) {
    const updates = await readUpdates(updatesPath, config);
    if (updates.messages.length > 0 || updates.collector.getSummaries().length > 0) return updates;
  }

  const historyPath = path.join(sessionDir, 'chat_history.jsonl');
  if (await pathExists(historyPath)) return readChatHistory(historyPath, config);
  if (await pathExists(updatesPath)) return readUpdates(updatesPath, config);
  return undefined;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  } catch (err) {
    logger.debug('grok: cannot stat file', filePath, err);
    return 0;
  }
}

async function sessionToUnified(
  sessionDir: string,
  groupCwd: string,
  options: SessionParseOptions | undefined,
): Promise<UnifiedSession | null> {
  const summaryPath = path.join(sessionDir, 'summary.json');
  const summary = (await pathExists(summaryPath)) ? await readJsonRecord(summaryPath) : undefined;
  const summaryUnreadable = (await pathExists(summaryPath)) && !summary;
  const updatesPath = path.join(sessionDir, 'updates.jsonl');
  const historyPath = path.join(sessionDir, 'chat_history.jsonl');
  const hasTranscript = (await pathExists(updatesPath)) || (await pathExists(historyPath));
  if (summaryUnreadable && !hasTranscript) return null;
  if (!summary && !hasTranscript) return null;

  const info = isRecord(summary?.info) ? summary.info : undefined;
  const id = stringField(info, 'id') || path.basename(sessionDir);
  const cwd = normalizeCwd(stringField(info, 'cwd') || groupCwd);
  if (options?.cwd && cwd && !matchesCwd(cwd, options.cwd)) return null;
  if (options?.cwd && !cwd) return null;

  const title =
    stringField(summary, 'generated_title') ||
    stringField(summary, 'session_summary') ||
    stringField(summary, 'last_turn_summary');
  const remotes = Array.isArray(summary?.git_remotes) ? summary.git_remotes : [];
  const gitUrl = remotes.find((remote): remote is string => typeof remote === 'string');
  const createdAt = parseIso(summary?.created_at);
  const updatedAt = parseIso(summary?.updated_at) || parseIso(summary?.last_active_at);

  let bytes = 0;
  let mtime: Date | undefined;
  for (const name of TRANSCRIPT_FILES) {
    const transcriptPath = path.join(sessionDir, name);
    try {
      const stat = await fs.promises.stat(transcriptPath);
      bytes += stat.size;
      if (!mtime || stat.mtime > mtime) mtime = stat.mtime;
    } catch (err) {
      logger.debug('grok: transcript stat skipped', transcriptPath, err);
    }
  }
  if (bytes === 0) bytes = await fileSize(summaryPath);

  // Point at the transcript file so `inspect` can stream events. Extraction
  // still uses the session directory when this path is a file.
  const originalPath = (await pathExists(updatesPath)) ? updatesPath : hasTranscript ? historyPath : sessionDir;

  return {
    id,
    source: 'grok',
    cwd,
    repo: extractRepo({ gitUrl, cwd }) || undefined,
    branch: stringField(summary, 'head_branch'),
    gitSha: stringField(summary, 'head_commit'),
    summary: title ? cleanSummary(title) : undefined,
    lines: numberField(summary, 'num_chat_messages') ?? numberField(summary, 'num_messages') ?? 0,
    bytes,
    createdAt: createdAt || mtime || new Date(0),
    updatedAt: updatedAt || mtime || createdAt || new Date(0),
    originalPath,
    model: stringField(summary, 'current_model_id'),
  };
}

/**
 * Discover Grok Build sessions from `$GROK_HOME/sessions` (default `~/.grok/sessions`).
 */
export async function parseGrokSessions(options?: SessionParseOptions): Promise<UnifiedSession[]> {
  const root = sessionsRoot();
  if (!(await pathExists(root))) return [];

  const sessions: UnifiedSession[] = [];
  for (const groupPath of await listSubdirectories(root)) {
    const groupCwd = await cwdFromGroup(groupPath, path.basename(groupPath));
    if (options?.cwd && groupCwd && !matchesCwd(groupCwd, options.cwd)) continue;

    for (const sessionDir of await listSubdirectories(groupPath)) {
      if (!(await isSessionDir(sessionDir))) continue;
      try {
        const session = await sessionToUnified(sessionDir, groupCwd, options);
        if (session) sessions.push(session);
      } catch (err) {
        logger.debug('grok: skipping unparseable session', sessionDir, err);
      }
    }
  }

  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  if (options?.limit !== undefined && options.limit >= 0) return sessions.slice(0, options.limit);
  return sessions;
}

/**
 * Extract handoff context from a Grok Build session directory.
 */
export async function extractGrokContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolved = config ?? getPreset('standard');
  let sessionDir = session.originalPath;
  try {
    const stat = await fs.promises.stat(session.originalPath);
    if (!stat.isDirectory()) sessionDir = path.dirname(session.originalPath);
  } catch (err) {
    logger.debug('grok: session path is not available', session.originalPath, err);
  }

  const transcript = await readTranscript(sessionDir, resolved);
  const notes: SessionNotes = { ...(transcript?.notes ?? {}) };
  notes.rawAccess = { kind: 'directory', path: sessionDir, redacted: true };

  const fidelityWarnings: string[] = [];
  if (!transcript) {
    fidelityWarnings.push('Grok session transcript (updates.jsonl or chat_history.jsonl) was not found.');
  } else if (path.basename(transcript.sourceFile) === 'chat_history.jsonl') {
    fidelityWarnings.push('Grok updates.jsonl had no conversation; chat_history.jsonl was used instead.');
  }
  if (transcript && transcript.droppedLines > 0) {
    fidelityWarnings.push(`Grok transcript skipped ${transcript.droppedLines} malformed line(s).`);
  }
  if (fidelityWarnings.length > 0) notes.fidelityWarnings = fidelityWarnings;

  const usage = await readJsonRecord(path.join(sessionDir, 'usage.json'));
  const usageSession = isRecord(usage?.session) ? usage.session : undefined;
  if (usageSession) captureUsage(notes, usageSession);

  let pendingTasks = transcript?.pendingTasks ?? [];
  if (!transcript?.sawPlanEvent) {
    const fromFile = planTasksFromFile(await readJsonRecord(path.join(sessionDir, 'plan.json')));
    if (fromFile.length > 0) pendingTasks = fromFile;
  }
  pendingTasks = pendingTasks.slice(0, resolved.pendingTasks.maxTasks);

  const collector = transcript?.collector ?? new ToolSummaryCollector(resolved);
  const recentMessages = trimMessages(transcript?.messages ?? [], resolved.recentMessages);
  const filesModified = collector.getFilesModified();
  const toolSummaries = collector.getSummaries();
  const markdown = generateHandoffMarkdown(
    session,
    recentMessages,
    filesModified,
    pendingTasks,
    toolSummaries,
    notes,
    resolved,
  );

  return {
    session,
    recentMessages,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes: notes,
    markdown,
  };
}

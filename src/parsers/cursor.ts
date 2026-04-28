import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionNotes, UnifiedSession } from '../types/index.js';
import { CursorTranscriptLineSchema } from '../types/schemas.js';
import { cleanUserQueryText, isRealUserMessage, isSystemContent } from '../utils/content.js';
import { findFiles } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { cwdFromSlug } from '../utils/slug.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';

const CURSOR_PROJECTS_DIR = path.join(homeDir(), '.cursor', 'projects');
const CURSOR_FIDELITY_WARNING =
  'Cursor transcript completeness warning: local agent-transcripts are partial exports and may omit tool outputs, images, reasoning, compaction markers, or other hidden SQLite/session state.';
const CURSOR_TIMESTAMP_TAG_RE = /<timestamp>([\s\S]*?)<\/timestamp>/i;
const CURSOR_TIMESTAMP_TAG_GLOBAL_RE = /<timestamp>[\s\S]*?<\/timestamp>/gi;
// Supported `<timestamp>` body shapes (English locale only, per Cursor's
// hard-coded format observed in the wild and corroborated by VibeLens'
// `_TIMESTAMP_BODY_RE`):
//   `Sunday, Apr 26, 2026, 9:53 PM`
//   `Sunday, Apr 26, 2026, 9:53 PM (UTC-4)`
//   `Apr 26, 2026, 9:53 PM (UTC+05:30)`
// The optional weekday prefix and (UTC±H[:MM]) suffix are both tolerated.
// Locale-specific or named-tz timestamps fall back to file mtime via
// `fs.statSync(filePath)` in `parseCursorSessions`.
const CURSOR_TIMESTAMP_BODY_RE =
  /(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+([AP]M)\s*(?:\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\))?/i;

interface CursorContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface NormalizedCursorLine {
  role: 'user' | 'assistant';
  content: CursorContentBlock[];
  raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function getStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumberField(record: Record<string, unknown> | undefined, key: string): number {
  if (!record) return 0;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeContentBlock(value: unknown): CursorContentBlock | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  // Spread the raw fields, then sanitize `text` so a non-string upstream value
  // can never reach downstream consumers (which assume `block.text: string`).
  const block: CursorContentBlock = { ...value, type: value.type };
  if (typeof value.text === 'string') {
    block.text = value.text;
  } else if ('text' in block) {
    delete block.text;
  }
  return block;
}

function normalizeContentBlocks(content: unknown): CursorContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];

  const blocks: CursorContentBlock[] = [];
  for (const item of content) {
    const block = normalizeContentBlock(item);
    if (block) blocks.push(block);
  }
  return blocks;
}

function normalizeCursorLine(record: unknown): NormalizedCursorLine | null {
  const parsed = CursorTranscriptLineSchema.safeParse(record);
  if (parsed.success) {
    return {
      role: parsed.data.role,
      content: normalizeContentBlocks(parsed.data.message.content),
      raw: isRecord(record) ? record : {},
    };
  }

  if (!isRecord(record)) return null;
  const role = record.role;
  if (role !== 'user' && role !== 'assistant') return null;

  const message = getRecordField(record, 'message');
  const content = normalizeContentBlocks(message?.content);
  if (content.length === 0) return null;

  return { role, content, raw: record };
}

function stripCursorMetadataTags(text: string): string {
  return text.replace(CURSOR_TIMESTAMP_TAG_GLOBAL_RE, '').trim();
}

function cleanCursorUserText(text: string): string {
  return stripCursorMetadataTags(cleanUserQueryText(text)).trim();
}

function isCursorNoiseText(rawText: string, cleanedText: string, role: NormalizedCursorLine['role']): boolean {
  const raw = rawText.trim();
  const cleaned = cleanedText.trim();
  if (!cleaned) return true;
  if (isSystemContent(raw) || isSystemContent(cleaned)) return true;
  if (raw.startsWith('<system_reminder>') || cleaned.startsWith('<system_reminder>')) return true;
  if (role === 'user' && !isRealUserMessage(cleaned)) return true;
  return false;
}

function parseCursorTimestampTag(text: string): Date | undefined {
  const tag = CURSOR_TIMESTAMP_TAG_RE.exec(text);
  if (!tag?.[1]) return undefined;

  const match = CURSOR_TIMESTAMP_BODY_RE.exec(tag[1]);
  if (!match) return undefined;

  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, offsetSign, offsetHourText, offsetMinuteText] =
    match;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
    monthName.slice(0, 3).toLowerCase(),
  );
  if (month < 0) return undefined;

  const year = Number(yearText);
  const day = Number(dayText);
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(year) || !Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return undefined;
  }
  if (meridiem.toUpperCase() === 'PM' && hour < 12) hour += 12;
  if (meridiem.toUpperCase() === 'AM' && hour === 12) hour = 0;

  const offsetHours = offsetHourText ? Number(offsetHourText) : 0;
  const offsetMinutes = offsetMinuteText ? Number(offsetMinuteText) : 0;
  const signedOffsetMinutes =
    offsetSign === '-' ? -(offsetHours * 60 + offsetMinutes) : offsetHours * 60 + offsetMinutes;
  const utcMillis = Date.UTC(year, month, day, hour, minute) - signedOffsetMinutes * 60_000;
  const date = new Date(utcMillis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function extractLineTimestamp(line: NormalizedCursorLine): Date | undefined {
  const message = getRecordField(line.raw, 'message');
  const explicit =
    parseDate(getStringField(line.raw, 'timestamp')) ??
    parseDate(getStringField(line.raw, 'createdAt')) ??
    parseDate(getStringField(message, 'timestamp')) ??
    parseDate(getStringField(message, 'createdAt'));
  if (explicit) return explicit;

  for (const block of line.content) {
    if (block.type !== 'text' || !block.text) continue;
    const tagged = parseCursorTimestampTag(block.text);
    if (tagged) return tagged;
  }
  return undefined;
}

function extractLineModel(line: NormalizedCursorLine): string | undefined {
  if (line.role !== 'assistant') return undefined;
  const message = getRecordField(line.raw, 'message');
  return getStringField(line.raw, 'model') ?? getStringField(message, 'model');
}

function extractLineUsage(line: NormalizedCursorLine): Record<string, unknown> | undefined {
  if (line.role !== 'assistant') return undefined;
  const message = getRecordField(line.raw, 'message');
  return getRecordField(line.raw, 'usage') ?? (message ? getRecordField(message, 'usage') : undefined);
}

async function readNormalizedTranscript(filePath: string): Promise<NormalizedCursorLine[]> {
  const records = await readJsonlFile<unknown>(filePath);
  const lines: NormalizedCursorLine[] = [];
  for (const record of records) {
    const line = normalizeCursorLine(record);
    if (line) {
      lines.push(line);
    } else {
      logger.debug('cursor: skipping malformed transcript record', filePath);
    }
  }
  return lines;
}

/**
 * Find all Cursor agent-transcript JSONL files.
 *
 * Cursor writes transcripts under `~/.cursor/projects/<project-slug>/agent-transcripts/`
 * in two observed layouts:
 *   - nested: `<uuid>/transcript.jsonl` (or `<uuid>/<uuid>.jsonl`)
 *   - flat:   `<uuid>.jsonl`
 *
 * The recursive scan accepts both. Discovery does not assume a particular
 * filename — `getSessionId()` derives the UUID, and `parseCursorSessions()`
 * deduplicates by id when both layouts coexist for the same session.
 */
async function findTranscriptFiles(): Promise<string[]> {
  if (!fs.existsSync(CURSOR_PROJECTS_DIR)) return [];

  const files: string[] = [];
  try {
    const projectDirs = fs.readdirSync(CURSOR_PROJECTS_DIR, { withFileTypes: true });
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, projectDir.name, 'agent-transcripts');
      const found = findFiles(transcriptsDir, {
        match: (entry, fullPath) => entry.name.endsWith('.jsonl') && fullPath.includes('agent-transcripts'),
        maxDepth: 2,
      });
      files.push(...found);
    }
  } catch (err) {
    logger.debug('cursor: cannot read base directory', CURSOR_PROJECTS_DIR, err);
    // Skip if base dir can't be read
  }
  return files;
}

/**
 * Extract the project slug from a transcript file path.
 */
function getProjectSlug(filePath: string): string {
  const parts = filePath.split(path.sep);
  const projectsIdx = parts.indexOf('projects');
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
    return parts[projectsIdx + 1];
  }
  return '';
}

function getProjectDir(filePath: string): string {
  const parts = filePath.split(path.sep);
  const projectsIdx = parts.indexOf('projects');
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
    return parts.slice(0, projectsIdx + 2).join(path.sep);
  }
  return '';
}

function getSessionId(filePath: string): string {
  const stem = path.basename(filePath, '.jsonl');
  if (stem === 'transcript') {
    const parent = path.basename(path.dirname(filePath));
    if (parent && parent !== 'agent-transcripts' && parent !== 'subagents') return parent;
  }
  return stem;
}

/**
 * Resolve the project working directory from `repo.json`, with cached results.
 *
 * Cursor does not officially document the `repo.json` schema (see
 * docs/parser-documentation/access-recipes/07-cursor.md), so the key
 * precedence below is observed/inferred:
 *
 *   workspace > rootPath > path
 *
 * Independently corroborated by VibeLens (CHATS-lab/VibeLens
 * `src/vibelens/ingest/parsers/cursor.py`), which uses the same order.
 *
 * Falls back to slug-derived cwd when `repo.json` is absent or unreadable.
 */
async function resolveProjectCwd(projectDir: string, slug: string, cache: Map<string, string>): Promise<string> {
  const fallback = cwdFromSlug(slug);
  if (!projectDir) return fallback;

  // Cache the resolved cwd per project directory: a single `repo.json` is
  // shared by every transcript in a project, and discovery typically iterates
  // many sibling sessions in the same project.
  const cached = cache.get(projectDir);
  if (cached !== undefined) return cached || fallback;

  const repoJsonPath = path.join(projectDir, 'repo.json');
  if (!fs.existsSync(repoJsonPath)) {
    cache.set(projectDir, '');
    return fallback;
  }

  let resolved = '';
  try {
    const content = await fs.promises.readFile(repoJsonPath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed)) {
      for (const key of ['workspace', 'rootPath', 'path']) {
        const value = getStringField(parsed, key);
        if (value) {
          resolved = value;
          break;
        }
      }
    }
  } catch (err) {
    logger.debug('cursor: failed to read project metadata', repoJsonPath, err);
  }

  cache.set(projectDir, resolved);
  return resolved || fallback;
}

/**
 * Parse first few messages for summary
 */
async function parseSessionInfo(filePath: string): Promise<{
  firstUserMessage: string;
  firstTimestamp?: Date;
  lineCount: number;
  bytes: number;
  model?: string;
}> {
  let firstUserMessage = '';
  let firstTimestamp: Date | undefined;
  let model: string | undefined;

  // Stream-count lines without full JSON parse (fast)
  const stats = await getFileStats(filePath);

  // Scan head for first user message. The 100-record cap is a discovery
  // optimization (avoids streaming megabyte transcripts twice — once here,
  // once in `extractCursorContext`). The discovery path treats a missing
  // first-user-message as cosmetic-only: `parseCursorSessions` no longer
  // gates on `messageCount`, so a session whose first user record lives
  // past the head window still surfaces — it just lists without a summary
  // until the user opens it (covered by the
  // 'keeps long transcripts whose first parseable record sits past the head
  //  scan window' regression test).
  await scanJsonlHead(filePath, 100, (parsed) => {
    const line = normalizeCursorLine(parsed);
    if (!line) return 'continue';

    const timestamp = extractLineTimestamp(line);
    if (timestamp) {
      if (!firstTimestamp) firstTimestamp = timestamp;
    }

    model ??= extractLineModel(line);

    if (!firstUserMessage && line.role === 'user') {
      for (const block of line.content) {
        if (block.type !== 'text' || !block.text) continue;
        const cleaned = cleanCursorUserText(block.text);
        if (!isCursorNoiseText(block.text, cleaned, line.role)) {
          firstUserMessage = cleaned;
          break;
        }
      }
    }

    return 'continue';
  });

  return {
    firstUserMessage,
    firstTimestamp,
    lineCount: stats.lines,
    bytes: stats.bytes,
    model,
  };
}

/**
 * Parse all Cursor sessions
 */
export async function parseCursorSessions(): Promise<UnifiedSession[]> {
  const files = await findTranscriptFiles();
  const sessionsById = new Map<string, UnifiedSession>();
  const projectCwdCache = new Map<string, string>();

  for (const filePath of files) {
    try {
      const { firstUserMessage, firstTimestamp, lineCount, bytes, model } = await parseSessionInfo(filePath);
      // Do not gate on head-scan `messageCount`: a long session whose first
      // valid record sits past the 100-line head would be dropped here even
      // though `extractCursorContext()` reads the full file. The downstream
      // `lines > 0 && bytes > 0` filter still excludes truly empty files.
      const fileStats = fs.statSync(filePath);
      const slug = getProjectSlug(filePath);
      const cwd = await resolveProjectCwd(getProjectDir(filePath), slug, projectCwdCache);

      const summary = cleanSummary(firstUserMessage);

      const id = getSessionId(filePath);
      const next: UnifiedSession = {
        id,
        source: 'cursor',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines: lineCount,
        bytes,
        createdAt: firstTimestamp ?? fileStats.birthtime,
        updatedAt: fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
        model,
      };

      // Discovery may surface the same logical session twice when a session
      // dir contains both `<uuid>/transcript.jsonl` and `<uuid>.jsonl` (or a
      // legacy `<uuid>/<uuid>.jsonl` left behind). Keep the most recently
      // updated copy so the picker shows the canonical entry.
      const existing = sessionsById.get(id);
      if (!existing || existing.updatedAt.getTime() < next.updatedAt.getTime()) {
        sessionsById.set(id, next);
      }
    } catch (err) {
      logger.debug('cursor: skipping unparseable session', filePath, err);
      // Skip files we can't parse
    }
  }

  return Array.from(sessionsById.values())
    .filter((s) => s.bytes > 0 && s.lines > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from a Cursor session for cross-tool continuation
 */
export async function extractCursorContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const lines = await readNormalizedTranscript(session.originalPath);
  const recentMessages: ConversationMessage[] = [];

  // Extract tool data via shared Anthropic utility
  const anthropicMsgs: AnthropicMessage[] = lines.map((l) => ({
    role: l.role,
    content: l.content,
  }));

  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMsgs, resolvedConfig);

  // Extract session notes (thinking highlights + token usage)
  const sessionNotes: SessionNotes = {};
  const reasoning = extractThinkingHighlights(anthropicMsgs);
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;
  sessionNotes.fidelityWarnings = [CURSOR_FIDELITY_WARNING];

  // Aggregate token usage, cache tokens, and model from passthrough fields.
  // Cursor CLI agent-transcripts use Anthropic API format — the schema's
  // .passthrough() preserves `usage` and `model` on each JSONL line.
  for (const line of lines) {
    if (line.role !== 'assistant') continue;

    // Model: take the first one found (all lines in a session use the same model)
    const model = extractLineModel(line);
    if (model && !sessionNotes.model) {
      sessionNotes.model = model;
    }

    // Usage may be at top level or nested under message (both observed in the wild)
    const usage = extractLineUsage(line);
    if (!usage) continue;

    if (!sessionNotes.tokenUsage) sessionNotes.tokenUsage = { input: 0, output: 0 };
    sessionNotes.tokenUsage.input += getNumberField(usage, 'input_tokens');
    sessionNotes.tokenUsage.output += getNumberField(usage, 'output_tokens');

    const cacheCreation = getNumberField(usage, 'cache_creation_input_tokens');
    const cacheRead = getNumberField(usage, 'cache_read_input_tokens');
    if (cacheCreation || cacheRead) {
      if (!sessionNotes.cacheTokens) sessionNotes.cacheTokens = { creation: 0, read: 0 };
      sessionNotes.cacheTokens.creation += cacheCreation;
      sessionNotes.cacheTokens.read += cacheRead;
    }
  }

  const pendingTasks: string[] = [];

  for (const line of lines) {
    const textParts: string[] = [];
    for (const block of line.content) {
      if (block.type === 'text' && block.text) {
        const cleaned = line.role === 'user' ? cleanCursorUserText(block.text) : stripCursorMetadataTags(block.text);
        if (isCursorNoiseText(block.text, cleaned, line.role)) continue;
        if (cleaned) textParts.push(cleaned);
      }
    }

    const text = textParts.join('\n').trim();
    if (!text) continue;

    recentMessages.push({
      role: line.role === 'user' ? 'user' : 'assistant',
      content: text,
      timestamp: extractLineTimestamp(line),
    });
  }

  const trimmed = recentMessages.slice(-resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    resolvedConfig,
  );

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

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type { ConversationMessage, SessionContext, SessionSource, UnifiedSession } from '../types/index.js';
import { findFiles, listSubdirectories } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, homeDir } from '../utils/parser-helpers.js';

const ANTIGRAVITY_BASE_DIR = path.join(
  process.env.GEMINI_CLI_HOME || homeDir(),
  '.gemini',
  'antigravity',
  'code_tracker',
);

const SOURCE_NAME: SessionSource = 'antigravity';

// ⚠️  FORMAT NOTE: This parser handles JSON conversation logs from Antigravity's
// code_tracker directory. Real Antigravity installations may also store raw file
// snapshots (binary/text diffs) in code_tracker/ — those are NOT parsed here.
// This parser processes *.json (and legacy *.jsonl) files containing {type, content, timestamp} entries.

/** Shape of a single line entry after stripping the binary prefix */
interface AntigravityEntry {
  type: string;
  timestamp: string;
  content: string;
}

// ── Line Parsing ────────────────────────────────────────────────────────────

/**
 * Strip binary/protobuf prefix bytes that precede the JSON on each session file line.
 * Returns the substring starting from the first `{`, or null if none found.
 */
function stripBinaryPrefix(line: string): string | null {
  const idx = line.indexOf('{');
  if (idx === -1) return null;
  return line.slice(idx);
}

/**
 * Parse a single line into an entry.
 * Returns null for empty lines, lines without JSON, or invalid payloads.
 */
function parseLine(line: string): AntigravityEntry | null {
  if (!line) return null;
  const json = stripBinaryPrefix(line);
  if (!json) return null;

  try {
    const obj = JSON.parse(json);
    if (typeof obj === 'object' && obj !== null && typeof obj.type === 'string' && typeof obj.content === 'string') {
      return {
        type: obj.type,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
        content: obj.content,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── File I/O ────────────────────────────────────────────────────────────────

/** Read and parse all entries from an Antigravity session file (streamed) */
async function parseSessionFile(filePath: string): Promise<AntigravityEntry[]> {
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const entries: AntigravityEntry[] = [];
    for await (const line of rl) {
      const entry = parseLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch (err) {
    logger.debug('antigravity: failed to read session file', filePath, err);
    return [];
  }
}

/** Parse an RFC 3339 / ISO 8601 timestamp, falling back to a default Date */
function parseTimestamp(ts: string, fallback: Date): Date {
  if (!ts) return fallback;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** Tuple returned by findSessionFiles — captures the project directory at discovery time */
interface SessionFileEntry {
  filePath: string;
  projectDir: string;
}

/** Find all *.json / *.jsonl session files under the code_tracker project dirs */
async function findSessionFiles(): Promise<SessionFileEntry[]> {
  if (!fs.existsSync(ANTIGRAVITY_BASE_DIR)) return [];

  const results: SessionFileEntry[] = [];
  for (const projectDir of listSubdirectories(ANTIGRAVITY_BASE_DIR)) {
    for (const filePath of findFiles(projectDir, {
      match: (entry) => entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'),
      recursive: true,
    })) {
      results.push({ filePath, projectDir });
    }
  }
  return results;
}

/**
 * Derive project name from the discovered project directory.
 * "no_repo" falls back to "antigravity".
 * Strips trailing _<hex-hash> suffix (e.g., "marketing_c6b0a246..." → "marketing").
 */
function projectNameFromDir(projectDir: string): string {
  const dirName = path.basename(projectDir);
  if (dirName === 'no_repo') return 'antigravity';
  const hashSuffix = dirName.match(/_[0-9a-f]{8,}$/);
  return hashSuffix ? dirName.slice(0, hashSuffix.index) : dirName;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse all Antigravity sessions from ~/.gemini/antigravity/code_tracker/
 */
export async function parseAntigravitySessions(): Promise<UnifiedSession[]> {
  const files = await findSessionFiles();
  const sessions: UnifiedSession[] = [];

  for (const { filePath, projectDir } of files) {
    try {
      const entries = await parseSessionFile(filePath);
      const relevant = entries.filter((e) => e.type === 'user' || e.type === 'assistant');
      if (relevant.length === 0) continue;

      const fileStats = await fsp.stat(filePath);
      const mtime = fileStats.mtime;

      let sessionId = path.basename(filePath);
      if (sessionId.endsWith('.json')) sessionId = sessionId.slice(0, -5);
      else if (sessionId.endsWith('.jsonl')) sessionId = sessionId.slice(0, -6);
      const projectName = projectNameFromDir(projectDir);

      const firstUser = relevant.find((e) => e.type === 'user');
      const summary = firstUser ? cleanSummary(firstUser.content) : undefined;

      const createdAt = parseTimestamp(relevant[0].timestamp, mtime);
      const updatedAt = parseTimestamp(relevant[relevant.length - 1].timestamp, mtime);

      sessions.push({
        id: sessionId,
        source: SOURCE_NAME,
        cwd: '',
        repo: projectName,
        lines: relevant.length,
        bytes: fileStats.size,
        createdAt,
        updatedAt,
        originalPath: filePath,
        summary,
      });
    } catch (err) {
      logger.debug('antigravity: skipping unparseable session', filePath, err);
    }
  }

  return sessions
    .filter((s) => s.summary && s.summary.length > 0)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Extract context from an Antigravity session for cross-tool continuation.
 * Antigravity sessions contain only user/assistant messages — no tool calls or token tracking.
 */
export async function extractAntigravityContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const entries = await parseSessionFile(session.originalPath);

  let fallbackDate = session.updatedAt;
  try {
    const stat = await fsp.stat(session.originalPath);
    fallbackDate = stat.mtime;
  } catch (err) {
    logger.debug('antigravity: stat failed, using session.updatedAt', err);
  }

  const allMessages: ConversationMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    allMessages.push({
      role: entry.type as 'user' | 'assistant',
      content: entry.content,
      timestamp: parseTimestamp(entry.timestamp, fallbackDate),
    });
  }

  const recentMessages = allMessages.slice(-resolvedConfig.recentMessages);

  const markdown = generateHandoffMarkdown(
    session,
    recentMessages,
    [], // filesModified — not tracked by Antigravity
    [], // pendingTasks — not tracked by Antigravity
    [], // toolSummaries — no tool calls in Antigravity
    undefined, // sessionNotes — no tokens/reasoning
    resolvedConfig,
  );

  return {
    session,
    recentMessages,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    sessionNotes: undefined,
    markdown,
  };
}

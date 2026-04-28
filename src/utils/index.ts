import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { VerbosityConfig } from '../config/index.js';
import { UnknownSourceError } from '../errors.js';
import { logger } from '../logger.js';
import { ALL_TOOLS, adapters } from '../parsers/registry.js';
import type { SessionContext, SessionParseOptions, SessionSource, UnifiedSession } from '../types/index.js';
import { homeDir } from './parser-helpers.js';
import { matchesCwd } from './slug.js';

const CONTINUES_DIR = path.join(homeDir(), '.continues');
const INDEX_FILE = path.join(CONTINUES_DIR, 'sessions.jsonl');
const CONTEXTS_DIR = path.join(CONTINUES_DIR, 'contexts');

// Cache TTL in milliseconds (5 minutes)
const INDEX_TTL = 5 * 60 * 1000;

// Prefix for the env fingerprint line stored in the index file
const ENV_FINGERPRINT_PREFIX = '#env:';

/**
 * Build a fingerprint of environment variables that affect parser storage paths.
 * When any of these env vars change, the cached index must be rebuilt.
 */
function computeEnvFingerprint(source?: SessionSource): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const selectedAdapters = source ? [adapters[source]] : Object.values(adapters);
  const addEnvVar = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const val = process.env[name] || '';
    parts.push(`${name}=${val}`);
  };
  for (const adapter of selectedAdapters) {
    if (!adapter) continue;
    if (adapter.envVar) addEnvVar(adapter.envVar);
    if (adapter.extraEnvVars) {
      for (const name of adapter.extraEnvVars) addEnvVar(name);
    }
  }
  // Hash to avoid leaking user-specific paths in the on-disk cache
  return createHash('sha256').update(parts.sort().join('|')).digest('hex');
}

/**
 * Read the env fingerprint stored in the first line of the index file.
 */
function readStoredFingerprint(indexFile: string): string | null {
  try {
    const content = fs.readFileSync(indexFile, 'utf8');
    const firstLine = content.slice(0, content.indexOf('\n'));
    if (firstLine.startsWith(ENV_FINGERPRINT_PREFIX)) {
      return firstLine.slice(ENV_FINGERPRINT_PREFIX.length);
    }
    return null;
  } catch (err) {
    logger.debug('index: failed to read stored fingerprint', err);
    return null;
  }
}

function sourceIndexFile(source: SessionSource): string {
  return path.join(CONTINUES_DIR, `sessions.${source}.jsonl`);
}

function serializeSessions(sessions: UnifiedSession[]): string[] {
  return sessions.map((s) =>
    JSON.stringify({
      ...s,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }),
  );
}

function writeIndexFile(indexFile: string, sessions: UnifiedSession[], source?: SessionSource): void {
  const fingerprint = `${ENV_FINGERPRINT_PREFIX}${computeEnvFingerprint(source)}`;
  fs.writeFileSync(indexFile, fingerprint + '\n' + serializeSessions(sessions).join('\n') + '\n');
}

/**
 * Ensure continues directories exist
 */
export function ensureDirectories(): void {
  try {
    if (!fs.existsSync(CONTINUES_DIR)) {
      fs.mkdirSync(CONTINUES_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONTEXTS_DIR)) {
      fs.mkdirSync(CONTEXTS_DIR, { recursive: true });
    }
  } catch (err) {
    logger.debug('index: failed to create directories', err);
  }
}

/**
 * Check if index needs rebuilding
 */
export function indexNeedsRebuild(source?: SessionSource): boolean {
  const indexFile = source ? sourceIndexFile(source) : INDEX_FILE;
  try {
    const stats = fs.statSync(indexFile);
    const age = Date.now() - stats.mtime.getTime();
    if (age > INDEX_TTL) return true;

    // Rebuild if env vars affecting storage paths have changed
    const stored = readStoredFingerprint(indexFile);
    if (stored !== computeEnvFingerprint(source)) {
      logger.debug('index: env fingerprint changed, rebuilding');
      return true;
    }

    return false;
  } catch (err) {
    logger.debug('index: cache stale check failed', err);
    return true; // File doesn't exist or can't be read
  }
}

/**
 * Build the unified session index
 */
export async function buildIndex(force = false): Promise<UnifiedSession[]> {
  ensureDirectories();

  // Check if we can use cached index
  if (!force && !indexNeedsRebuild()) {
    return loadIndex();
  }

  // Parse all sessions from all sources in parallel — use allSettled so one
  // broken parser doesn't crash the entire CLI
  const results = await Promise.allSettled(Object.values(adapters).map((a) => a.parseSessions()));

  const allSessions = results
    .filter((r): r is PromiseFulfilledResult<UnifiedSession[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Sort by updated time (newest first)
  allSessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  // Write to index file — first line is the env fingerprint
  writeIndexFile(INDEX_FILE, allSessions);

  const sessionsBySource = new Map<SessionSource, UnifiedSession[]>();
  for (const session of allSessions) {
    const sourceSessions = sessionsBySource.get(session.source) ?? [];
    sourceSessions.push(session);
    sessionsBySource.set(session.source, sourceSessions);
  }
  for (const source of ALL_TOOLS) {
    writeIndexFile(sourceIndexFile(source), sessionsBySource.get(source) ?? [], source);
  }

  return allSessions;
}

/**
 * Build or load the index for a single source without rebuilding every adapter.
 */
export async function buildSourceIndex(
  source: SessionSource,
  force = false,
  parseOptions: SessionParseOptions = { lightweight: true },
): Promise<UnifiedSession[]> {
  ensureDirectories();

  if (!force && !indexNeedsRebuild(source)) {
    return loadIndex(source);
  }

  // If the global cache is fresh, derive the source cache from it instead of parsing.
  if (!force && !indexNeedsRebuild()) {
    const sourceSessions = loadIndex().filter((session) => session.source === source);
    writeIndexFile(sourceIndexFile(source), sourceSessions, source);
    return sourceSessions;
  }

  const adapter = adapters[source];
  if (!adapter) return [];

  const sessions = await adapter.parseSessions(parseOptions);
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  writeIndexFile(sourceIndexFile(source), sessions, source);
  return sessions;
}

/**
 * Load sessions from the index file
 */
export function loadIndex(source?: SessionSource): UnifiedSession[] {
  const indexFile = source ? sourceIndexFile(source) : INDEX_FILE;
  try {
    const content = fs.readFileSync(indexFile, 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l && !l.startsWith(ENV_FINGERPRINT_PREFIX));

    return lines.flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return [
          {
            ...parsed,
            createdAt: new Date(parsed.createdAt),
            updatedAt: new Date(parsed.updatedAt),
          } as UnifiedSession,
        ];
      } catch (err) {
        logger.debug('index: skipping corrupted line in cache', err);
        return []; // Skip corrupted lines
      }
    });
  } catch (err) {
    logger.debug('index: cannot read cache file', indexFile, err);
    return []; // File doesn't exist or can't be read
  }
}

/**
 * Get all sessions (auto-rebuild if stale)
 */
export async function getAllSessions(forceRebuild = false): Promise<UnifiedSession[]> {
  return buildIndex(forceRebuild);
}

/**
 * Get sessions filtered by source
 */
export async function getSessionsBySource(source: SessionSource, forceRebuild = false): Promise<UnifiedSession[]> {
  return buildSourceIndex(source, forceRebuild, { lightweight: true });
}

/**
 * Get current-working-directory sessions from the complete index.
 */
export async function getSessionsByCwd(cwd: string, forceRebuild = false): Promise<UnifiedSession[]> {
  const sessions = await buildIndex(forceRebuild);
  return sessions.filter((session) => matchesCwd(session.cwd, cwd));
}

/**
 * Find a session by ID
 */
export async function findSession(id: string): Promise<UnifiedSession | null> {
  const all = await getAllSessions();
  return all.find((s) => s.id === id || s.id.startsWith(id)) || null;
}

/**
 * Extract context from a session based on its source
 */
export async function extractContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const adapter = adapters[session.source];
  if (!adapter) throw new UnknownSourceError(session.source);
  return adapter.extractContext(session, config);
}

/**
 * Save context to disk for cross-tool injection
 */
export function saveContext(context: SessionContext): string {
  ensureDirectories();

  const contextPath = path.join(CONTEXTS_DIR, `${context.session.id}.md`);
  fs.writeFileSync(contextPath, context.markdown);

  return contextPath;
}

/**
 * Get cached context if available
 */
export function getCachedContext(sessionId: string): string | null {
  const contextPath = path.join(CONTEXTS_DIR, `${sessionId}.md`);

  if (fs.existsSync(contextPath)) {
    return fs.readFileSync(contextPath, 'utf8');
  }

  return null;
}

/**
 * Format session for display
 */
export function formatSession(session: UnifiedSession): string {
  const tag = `[${session.source}]`;
  const source = tag.padEnd(10);
  const date = session.updatedAt.toISOString().slice(0, 16).replace('T', ' ');
  const repo = (session.repo || session.cwd.split('/').pop() || '').slice(0, 20).padEnd(20);
  const branch = (session.branch || '').slice(0, 15).padEnd(15);
  const summary = (session.summary || '').slice(0, 40);
  const id = session.id.slice(0, 12);

  return `${source} ${date}  ${repo} ${branch} ${summary.padEnd(40)} ${id}`;
}

/**
 * Format sessions as JSONL for output
 */
export function sessionsToJsonl(sessions: UnifiedSession[]): string {
  return sessions
    .map((s) =>
      JSON.stringify({
        ...s,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }),
    )
    .join('\n');
}

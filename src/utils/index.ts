import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedSession, SessionSource, SessionContext } from '../types/index.js';
import { adapters } from '../parsers/registry.js';
import { homeDir } from './parser-helpers.js';

const CONTINUES_DIR = path.join(homeDir(), '.continues');
const INDEX_FILE = path.join(CONTINUES_DIR, 'sessions.jsonl');
const CONTEXTS_DIR = path.join(CONTINUES_DIR, 'contexts');

// Cache TTL in milliseconds (5 minutes)
const INDEX_TTL = 5 * 60 * 1000;

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
    // Non-fatal — index/context operations will fail individually if dirs are missing
  }
}

/**
 * Check if index needs rebuilding
 */
export function indexNeedsRebuild(): boolean {
  try {
    const stats = fs.statSync(INDEX_FILE);
    const age = Date.now() - stats.mtime.getTime();
    return age > INDEX_TTL;
  } catch {
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
  const results = await Promise.allSettled(
    Object.values(adapters).map(a => a.parseSessions())
  );

  const allSessions = results
    .filter((r): r is PromiseFulfilledResult<UnifiedSession[]> => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // Sort by updated time (newest first)
  allSessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  // Write to index file
  const lines = allSessions.map(s => JSON.stringify({
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }));

  fs.writeFileSync(INDEX_FILE, lines.join('\n') + '\n');

  return allSessions;
}

/**
 * Load sessions from the index file
 */
export function loadIndex(): UnifiedSession[] {
  try {
    const content = fs.readFileSync(INDEX_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l);

    return lines.flatMap(line => {
      try {
        const parsed = JSON.parse(line);
        return [{
          ...parsed,
          createdAt: new Date(parsed.createdAt),
          updatedAt: new Date(parsed.updatedAt),
        } as UnifiedSession];
      } catch {
        return []; // Skip corrupted lines
      }
    });
  } catch {
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
  const all = await getAllSessions(forceRebuild);
  return all.filter(s => s.source === source);
}

/**
 * Find a session by ID
 */
export async function findSession(id: string): Promise<UnifiedSession | null> {
  const all = await getAllSessions();
  return all.find(s => s.id === id || s.id.startsWith(id)) || null;
}

/**
 * Extract context from a session based on its source
 */
export async function extractContext(session: UnifiedSession): Promise<SessionContext> {
  const adapter = adapters[session.source];
  if (!adapter) throw new Error(`Unknown session source: ${session.source}`);
  return adapter.extractContext(session);
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
  return sessions.map(s => JSON.stringify({
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  })).join('\n');
}

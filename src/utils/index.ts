import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedSession, SessionSource, SessionContext } from '../types/index.js';
import { parseCodexSessions, extractCodexContext } from '../parsers/codex.js';
import { parseClaudeSessions, extractClaudeContext } from '../parsers/claude.js';
import { parseCopilotSessions, extractCopilotContext } from '../parsers/copilot.js';
import { parseGeminiSessions, extractGeminiContext } from '../parsers/gemini.js';
import { parseOpenCodeSessions, extractOpenCodeContext } from '../parsers/opencode.js';
import { parseDroidSessions, extractDroidContext } from '../parsers/droid.js';

const CONTINUES_DIR = path.join(process.env.HOME || '~', '.continues');
const INDEX_FILE = path.join(CONTINUES_DIR, 'sessions.jsonl');
const CONTEXTS_DIR = path.join(CONTINUES_DIR, 'contexts');

// Cache TTL in milliseconds (5 minutes)
const INDEX_TTL = 5 * 60 * 1000;

/**
 * Ensure continues directories exist
 */
export function ensureDirectories(): void {
  if (!fs.existsSync(CONTINUES_DIR)) {
    fs.mkdirSync(CONTINUES_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONTEXTS_DIR)) {
    fs.mkdirSync(CONTEXTS_DIR, { recursive: true });
  }
}

/**
 * Check if index needs rebuilding
 */
export function indexNeedsRebuild(): boolean {
  if (!fs.existsSync(INDEX_FILE)) {
    return true;
  }

  const stats = fs.statSync(INDEX_FILE);
  const age = Date.now() - stats.mtime.getTime();
  return age > INDEX_TTL;
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

  // Parse all sessions from all sources in parallel
  const [codexSessions, claudeSessions, copilotSessions, geminiSessions, opencodeSessions, droidSessions] = await Promise.all([
    parseCodexSessions(),
    parseClaudeSessions(),
    parseCopilotSessions(),
    parseGeminiSessions(),
    parseOpenCodeSessions(),
    parseDroidSessions(),
  ]);

  const allSessions = [...codexSessions, ...claudeSessions, ...copilotSessions, ...geminiSessions, ...opencodeSessions, ...droidSessions];

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
  if (!fs.existsSync(INDEX_FILE)) {
    return [];
  }

  const content = fs.readFileSync(INDEX_FILE, 'utf8');
  const lines = content.trim().split('\n').filter(l => l);

  return lines.map(line => {
    const parsed = JSON.parse(line);
    return {
      ...parsed,
      createdAt: new Date(parsed.createdAt),
      updatedAt: new Date(parsed.updatedAt),
    } as UnifiedSession;
  });
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
  switch (session.source) {
    case 'codex':
      return extractCodexContext(session);
    case 'claude':
      return extractClaudeContext(session);
    case 'copilot':
      return extractCopilotContext(session);
    case 'gemini':
      return extractGeminiContext(session);
    case 'opencode':
      return extractOpenCodeContext(session);
    case 'droid':
      return extractDroidContext(session);
    default:
      throw new Error(`Unknown session source: ${session.source}`);
  }
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

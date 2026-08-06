import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSource, UnifiedSession } from '../types/index.js';

const testState = vi.hoisted(() => ({
  fakeHome: `/tmp/continues-index-source-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  parseClaude: vi.fn(),
  parseCodex: vi.fn(),
  parseCursor: vi.fn(),
}));

vi.mock('../utils/parser-helpers.js', () => ({
  homeDir: () => testState.fakeHome,
}));

vi.mock('../parsers/registry.js', () => ({
  ALL_TOOLS: ['claude', 'codex', 'cursor'],
  adapters: {
    claude: {
      name: 'claude',
      envVar: 'CLAUDE_CONFIG_DIR',
      parseSessions: testState.parseClaude,
      supportsCwdLookup: true,
    },
    codex: {
      name: 'codex',
      envVar: 'CODEX_HOME',
      parseSessions: testState.parseCodex,
    },
    cursor: {
      name: 'cursor',
      envVar: 'CURSOR_HOME',
      parseSessions: testState.parseCursor,
      supportsCwdLookup: true,
    },
  },
}));

const { getAllSessions, getSessionsByCwd, getSessionsBySource } = await import('../utils/index.js');

function makeSession(id: string, source: SessionSource, cwd = '/tmp/project'): UnifiedSession {
  return {
    id,
    source,
    cwd,
    lines: 0,
    bytes: 100,
    createdAt: new Date('2026-04-15T00:00:00.000Z'),
    updatedAt: new Date('2026-04-15T00:00:00.000Z'),
    originalPath: `/tmp/${id}.jsonl`,
    summary: `${source} session`,
  };
}

describe('source-scoped session index', () => {
  beforeEach(() => {
    fs.rmSync(testState.fakeHome, { recursive: true, force: true });
    testState.parseClaude.mockReset();
    testState.parseCodex.mockReset();
    testState.parseCursor.mockReset();
    testState.parseCursor.mockResolvedValue([]);
  });

  afterEach(() => {
    fs.rmSync(testState.fakeHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('source lookups rebuild only the requested source when no cache exists', async () => {
    testState.parseClaude.mockResolvedValue([makeSession('claude-1', 'claude')]);
    testState.parseCodex.mockResolvedValue([makeSession('codex-1', 'codex')]);

    const sessions = await getSessionsBySource('claude');

    expect(sessions.map((session) => session.id)).toEqual(['claude-1']);
    expect(testState.parseClaude).toHaveBeenCalledWith({ lightweight: true });
    expect(testState.parseCodex).not.toHaveBeenCalled();
  });

  it('source lookups reuse the source cache on repeated calls', async () => {
    testState.parseClaude.mockResolvedValue([makeSession('claude-1', 'claude')]);

    await getSessionsBySource('claude');
    const sessions = await getSessionsBySource('claude');

    expect(sessions.map((session) => session.id)).toEqual(['claude-1']);
    expect(testState.parseClaude).toHaveBeenCalledTimes(1);
  });

  it('full rebuild clears stale per-source caches for tools with zero sessions', async () => {
    testState.parseCodex.mockResolvedValue([makeSession('codex-old', 'codex')]);
    await getSessionsBySource('codex');

    testState.parseClaude.mockResolvedValue([makeSession('claude-1', 'claude')]);
    testState.parseCodex.mockResolvedValue([]);
    await getAllSessions(true);

    testState.parseCodex.mockClear();
    const sessions = await getSessionsBySource('codex');

    expect(sessions).toEqual([]);
    expect(testState.parseCodex).not.toHaveBeenCalled();
  });

  it('stale cwd lookups pass cwd only to adapters with direct cwd lookup', async () => {
    testState.parseClaude.mockResolvedValue([makeSession('claude-1', 'claude', '/tmp/project/subdir')]);
    testState.parseCodex.mockResolvedValue([makeSession('codex-1', 'codex', '/tmp/project')]);
    testState.parseCursor.mockResolvedValue([makeSession('cursor-1', 'cursor', '/tmp/project')]);

    const sessions = await getSessionsByCwd('/tmp/project');

    expect(sessions.map((session) => session.id)).toEqual(['claude-1', 'codex-1', 'cursor-1']);
    expect(testState.parseClaude).toHaveBeenCalledWith({ cwd: '/tmp/project' });
    expect(testState.parseCodex).toHaveBeenCalledWith();
    expect(testState.parseCursor).toHaveBeenCalledWith({ cwd: '/tmp/project' });
  });
});

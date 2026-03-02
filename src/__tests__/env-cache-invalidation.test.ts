/**
 * Regression test for GitHub issue #18:
 * CLAUDE_CONFIG_DIR environment variable is ignored when running continues resume.
 *
 * Root cause: the session index cache (~/.continues/sessions.jsonl) had a 5-min TTL
 * but did not track which env vars were in effect when the cache was built. Changing
 * CLAUDE_CONFIG_DIR (or any adapter envVar) would still serve the stale cache.
 *
 * Fix: store an env fingerprint as the first line of the index file and invalidate
 * when the fingerprint changes.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Create the fake home eagerly so it's ready before any mock evaluates
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-env-test-'));

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

// Mock homeDir() BEFORE importing the index module — the module evaluates
// CONTINUES_DIR = path.join(homeDir(), '.continues') at import time.
vi.mock('../utils/parser-helpers.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../utils/parser-helpers.js')>();
  return {
    ...orig,
    homeDir: () => fakeHome,
  };
});

// Now import the module under test — it will resolve INDEX_FILE under fakeHome.
const { indexNeedsRebuild, loadIndex, ensureDirectories } = await import('../utils/index.js');
const { adapters } = await import('../parsers/registry.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function indexFilePath(): string {
  return path.join(fakeHome, '.continues', 'sessions.jsonl');
}

function writeIndex(fingerprint: string, sessions: Record<string, unknown>[]): void {
  ensureDirectories();
  const lines = sessions.map((s) => JSON.stringify(s));
  fs.writeFileSync(indexFilePath(), fingerprint + '\n' + lines.join('\n') + '\n');
}

function makeSession(id: string, source = 'claude'): Record<string, unknown> {
  return {
    id,
    source,
    cwd: '/tmp/project',
    repo: 'test/repo',
    branch: 'main',
    lines: 10,
    bytes: 500,
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    originalPath: `/tmp/${id}.jsonl`,
  };
}

afterEach(() => {
  // Clean the index file between tests
  try { fs.unlinkSync(indexFilePath()); } catch (_) { /* file may not exist */ }
  vi.unstubAllEnvs();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('env fingerprint cache invalidation (issue #18)', () => {
  it('indexNeedsRebuild returns true when no index file exists', () => {
    expect(indexNeedsRebuild()).toBe(true);
  });

  it('indexNeedsRebuild returns false when index is fresh and fingerprint matches', () => {
    // Compute what the real module would write — import adapters to derive env vars
    // The simplest way: write an index via the fingerprint the module itself expects.
    // We write a fingerprint that matches the current env (all env vars unset in test).
    const parts: string[] = [];
    for (const adapter of Object.values(adapters) as Array<{ envVar?: string }>) {
      if (adapter.envVar) {
        const val = process.env[adapter.envVar] || '';
        parts.push(`${adapter.envVar}=${val}`);
      }
    }
    const fingerprint = `#env:${parts.sort().join('|')}`;

    writeIndex(fingerprint, [makeSession('sess-1')]);

    expect(indexNeedsRebuild()).toBe(false);
  });

  it('indexNeedsRebuild returns true when CLAUDE_CONFIG_DIR changes', () => {
    // Write index with current fingerprint (CLAUDE_CONFIG_DIR unset)
    const parts: string[] = [];
    for (const adapter of Object.values(adapters) as Array<{ envVar?: string }>) {
      if (adapter.envVar) {
        const val = process.env[adapter.envVar] || '';
        parts.push(`${adapter.envVar}=${val}`);
      }
    }
    const fingerprint = `#env:${parts.sort().join('|')}`;
    writeIndex(fingerprint, [makeSession('sess-1')]);

    // Now change the env var — fingerprint should mismatch
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/home/user/.claude-work');

    expect(indexNeedsRebuild()).toBe(true);
  });

  it('loadIndex skips the fingerprint line and returns only sessions', () => {
    writeIndex('#env:CLAUDE_CONFIG_DIR=', [
      makeSession('sess-1', 'claude'),
      makeSession('sess-2', 'codex'),
    ]);

    const sessions = loadIndex();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('sess-1');
    expect(sessions[1].id).toBe('sess-2');
    expect(sessions[0].createdAt).toBeInstanceOf(Date);
  });

  it('loadIndex returns empty array for non-existent file', () => {
    expect(loadIndex()).toEqual([]);
  });

  it('fingerprint line is not parseable as JSON', () => {
    const hash = createHash('sha256').update('test').digest('hex');
    expect(() => JSON.parse(`#env:\${hash}`)).toThrow();
  });
});

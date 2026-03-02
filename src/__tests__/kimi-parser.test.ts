import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tmpHomes: string[] = [];

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function createKimiSession(opts: {
  homeDir: string;
  workDirPath: string;
  sessionId: string;
  messages: unknown[];
  metadata?: Record<string, unknown>;
  rawMetadata?: string;
}): string {
  const hashDir = md5(opts.workDirPath);
  const sessionDir = path.join(opts.homeDir, '.kimi', 'sessions', hashDir, opts.sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  writeJsonl(path.join(sessionDir, 'context.jsonl'), opts.messages);

  if (opts.rawMetadata !== undefined) {
    fs.writeFileSync(path.join(sessionDir, 'metadata.json'), opts.rawMetadata, 'utf8');
  } else if (opts.metadata) {
    fs.writeFileSync(path.join(sessionDir, 'metadata.json'), JSON.stringify(opts.metadata), 'utf8');
  }

  return sessionDir;
}

function writeKimiConfig(homeDir: string, workDirs: Array<{ path: string; kaos?: string }>): void {
  const kimiDir = path.join(homeDir, '.kimi');
  fs.mkdirSync(kimiDir, { recursive: true });
  fs.writeFileSync(path.join(kimiDir, 'kimi.json'), JSON.stringify({ work_dirs: workDirs }, null, 2), 'utf8');
}

async function loadKimiParserWithHome(homeDir: string): Promise<typeof import('../parsers/kimi.js')> {
  vi.resetModules();
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });
  return import('../parsers/kimi.js');
}

afterEach(() => {
  vi.doUnmock('os');
  vi.resetModules();
  for (const tmpHome of tmpHomes) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  tmpHomes.length = 0;
});

describe('kimi parser hardening', () => {
  it('discovers sessions even when metadata.json is missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-no-metadata';
    const sessionId = 'missing-metadata-session';

    writeKimiConfig(home, [{ path: workDirPath }]);
    createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId,
      messages: [
        { role: 'user', content: 'Fix parser discovery' },
        { role: 'assistant', content: 'Done.' },
      ],
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe(workDirPath);
    expect(sessions[0].summary).toBe('Fix parser discovery');
  });

  it('accepts nullable wire_mtime and numeric archived_at metadata values', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-schema-compat';
    const sessionId = 'schema-compat-session';

    writeKimiConfig(home, [{ path: workDirPath }]);
    createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId,
      messages: [
        { role: 'user', content: 'Schema compatibility check' },
        { role: 'assistant', content: 'Looks good.' },
      ],
      metadata: {
        session_id: sessionId,
        archived: false,
        archived_at: 1735086302.21,
        wire_mtime: null,
      },
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
  });

  it('matches cwd deterministically when multiple work_dirs exist', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirA = '/tmp/workdir-alpha';
    const workDirB = '/tmp/workdir-beta';
    const sessionId = 'hash-match-session';

    // Put A first to ensure buggy "first entry wins" behavior would fail this test.
    writeKimiConfig(home, [{ path: workDirA }, { path: workDirB }]);
    createKimiSession({
      homeDir: home,
      workDirPath: workDirB,
      sessionId,
      messages: [
        { role: 'user', content: 'Use the correct repository cwd' },
        { role: 'assistant', content: 'Acknowledged.' },
      ],
      metadata: {
        session_id: sessionId,
      },
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe(workDirB);
    expect(sessions[0].cwd).not.toBe(workDirA);
  });

  it('uses latest _usage snapshot but does not fabricate input/output token split', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-token-usage';
    const sessionId = 'token-usage-session';

    writeKimiConfig(home, [{ path: workDirPath }]);
    const sessionDir = createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId,
      messages: [
        { role: 'user', content: 'Track token count correctly' },
        { role: 'assistant', content: [{ type: 'text', text: 'processing' }] },
        { role: '_usage', token_count: 100 },
        { role: '_usage', token_count: 250 },
      ],
      metadata: {
        session_id: sessionId,
      },
    });

    const { extractKimiContext } = await loadKimiParserWithHome(home);
    const session: UnifiedSession = {
      id: sessionId,
      source: 'kimi',
      cwd: workDirPath,
      repo: '',
      lines: 4,
      bytes: fs.statSync(path.join(sessionDir, 'context.jsonl')).size,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: sessionDir,
      summary: 'Token test',
    };

    const context = await extractKimiContext(session);
    expect(context.sessionNotes?.tokenUsage).toBeUndefined();
  });

  it('falls back safely when metadata is malformed and when work_dir hash has no match', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const sessionId = 'malformed-metadata-session';
    const unknownWorkDir = '/tmp/workdir-not-listed';

    writeKimiConfig(home, [{ path: '/tmp/other-workdir' }]);
    createKimiSession({
      homeDir: home,
      workDirPath: unknownWorkDir,
      sessionId,
      messages: [
        { role: 'user', content: 'Keep parsing despite malformed metadata' },
        { role: 'assistant', content: 'Will do.' },
      ],
      rawMetadata: '{ this-is-not-valid-json',
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe('');
  });

  it('excludes explicitly archived sessions but keeps non-archived ones', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-archive-behavior';

    writeKimiConfig(home, [{ path: workDirPath }]);
    createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId: 'active-session',
      messages: [
        { role: 'user', content: 'Active session should remain visible' },
        { role: 'assistant', content: 'Visible.' },
      ],
      metadata: {
        session_id: 'active-session',
        archived: false,
      },
    });
    createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId: 'archived-session',
      messages: [
        { role: 'user', content: 'Archived session should be hidden' },
        { role: 'assistant', content: 'Hidden.' },
      ],
      metadata: {
        session_id: 'archived-session',
        archived: true,
      },
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions.map((s) => s.id)).toContain('active-session');
    expect(sessions.map((s) => s.id)).not.toContain('archived-session');
  });
});

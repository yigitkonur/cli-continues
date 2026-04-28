import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tmpHomes: string[] = [];
const originalKimiShareDir = process.env.KIMI_SHARE_DIR;

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function writeRawContext(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function createKimiSession(opts: {
  homeDir: string;
  shareDir?: string;
  workDirPath: string;
  sessionId: string;
  messages: unknown[];
  metadata?: Record<string, unknown>;
  rawMetadata?: string;
}): string {
  const hashDir = md5(opts.workDirPath);
  const shareDir = opts.shareDir ?? path.join(opts.homeDir, '.kimi');
  const sessionDir = path.join(shareDir, 'sessions', hashDir, opts.sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  writeJsonl(path.join(sessionDir, 'context.jsonl'), opts.messages);

  if (opts.rawMetadata !== undefined) {
    fs.writeFileSync(path.join(sessionDir, 'metadata.json'), opts.rawMetadata, 'utf8');
  } else if (opts.metadata) {
    fs.writeFileSync(path.join(sessionDir, 'metadata.json'), JSON.stringify(opts.metadata), 'utf8');
  }

  return sessionDir;
}

function writeKimiState(sessionDir: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state), 'utf8');
}

function writeKimiWire(sessionDir: string, rows: unknown[]): void {
  writeJsonl(path.join(sessionDir, 'wire.jsonl'), rows);
}

function writeKimiConfigToShare(shareDir: string, workDirs: Array<{ path: string; kaos?: string }>): void {
  fs.mkdirSync(shareDir, { recursive: true });
  fs.writeFileSync(path.join(shareDir, 'kimi.json'), JSON.stringify({ work_dirs: workDirs }, null, 2), 'utf8');
}

function writeKimiConfig(homeDir: string, workDirs: Array<{ path: string; kaos?: string }>): void {
  writeKimiConfigToShare(path.join(homeDir, '.kimi'), workDirs);
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
  vi.doMock('../utils/markdown.js', () => ({
    generateHandoffMarkdown: () => 'mock kimi handoff markdown',
  }));
  return import('../parsers/kimi.js');
}

beforeEach(() => {
  delete process.env.KIMI_SHARE_DIR;
});

afterEach(() => {
  vi.doUnmock('os');
  vi.doUnmock('../utils/markdown.js');
  if (originalKimiShareDir === undefined) {
    delete process.env.KIMI_SHARE_DIR;
  } else {
    process.env.KIMI_SHARE_DIR = originalKimiShareDir;
  }
  vi.resetModules();
  for (const tmpHome of tmpHomes) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  tmpHomes.length = 0;
});

describe('kimi parser hardening', () => {
  it('uses KIMI_SHARE_DIR as the primary runtime directory when set', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-home-'));
    const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-share-'));
    tmpHomes.push(home, shareDir);
    process.env.KIMI_SHARE_DIR = shareDir;
    const workDirPath = '/tmp/project-share-dir';
    const sessionId = 'share-dir-session';

    writeKimiConfig(home, [{ path: '/tmp/fallback-home-project' }]);
    createKimiSession({
      homeDir: home,
      workDirPath: '/tmp/fallback-home-project',
      sessionId: 'fallback-home-session',
      messages: [{ role: 'user', content: 'Do not read from fallback home when KIMI_SHARE_DIR is set' }],
    });

    writeKimiConfigToShare(shareDir, [{ path: workDirPath }]);
    createKimiSession({
      homeDir: home,
      shareDir,
      workDirPath,
      sessionId,
      messages: [
        { role: 'user', content: 'Read from configured share dir' },
        { role: 'assistant', content: 'Using KIMI_SHARE_DIR.' },
      ],
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe(workDirPath);
    expect(sessions[0].originalPath.startsWith(shareDir)).toBe(true);
  });

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

  it('uses current state.json archive, title, and wire_mtime fields when present', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-state-json';
    const wireMtime = 1_735_086_302.21;

    writeKimiConfig(home, [{ path: workDirPath }]);
    const activeDir = createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId: 'state-active-session',
      messages: [{ role: 'assistant', content: 'No user title source.' }],
    });
    writeKimiState(activeDir, {
      custom_title: 'State title',
      title_generated: true,
      wire_mtime: wireMtime,
      archived: false,
    });

    const archivedDir = createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId: 'state-archived-session',
      messages: [{ role: 'user', content: 'Archived state session' }],
    });
    writeKimiState(archivedDir, {
      archived: true,
      archived_at: wireMtime,
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('state-active-session');
    expect(sessions[0].summary).toBe('State title');
    expect(sessions[0].updatedAt.getTime()).toBe(new Date(wireMtime * 1000).getTime());
  });

  it('treats state.json metadata as primary and metadata.json as a legacy fallback', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-state-primary';
    const sessionId = 'state-primary-session';
    const stateWireMtime = 1_735_086_500.5;

    writeKimiConfig(home, [{ path: workDirPath }]);
    const sessionDir = createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId,
      messages: [{ role: 'assistant', content: 'No user content.' }],
      metadata: {
        session_id: sessionId,
        title: 'Legacy title',
        archived: true,
        wire_mtime: 1,
      },
    });
    writeKimiState(sessionDir, {
      title: 'State title wins',
      archived: false,
      wire_mtime: stateWireMtime,
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe('State title wins');
    expect(sessions[0].updatedAt.getTime()).toBe(new Date(stateWireMtime * 1000).getTime());
  });

  it('derives repo and exposes optional wire/state/raw metadata during extraction', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/Users/alice/example-repo';
    const sessionId = 'wire-metadata-session';

    writeKimiConfig(home, [{ path: workDirPath }]);
    const sessionDir = createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId,
      messages: [
        { role: 'user', content: 'Inspect wire metadata' },
        { role: 'assistant', content: 'Wire metadata captured.' },
      ],
    });
    writeKimiState(sessionDir, {
      title: 'Wire metadata',
      approval: { yolo: false },
      additional_dirs: ['/tmp/extra'],
    });
    writeKimiWire(sessionDir, [
      { type: 'metadata', protocol_version: '1.6' },
      { message: { type: 'TurnBegin', payload: { user_input: 'Inspect wire metadata' } } },
      { type: 'ToolCall', id: 'tool-call-1' },
    ]);

    const { parseKimiSessions, extractKimiContext } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();
    const session = sessions[0];
    const context = await extractKimiContext(session);

    expect(session.repo).toBe('alice/example-repo');
    expect(context.sessionNotes?.rawAccess).toMatchObject({
      kind: 'directory',
      path: sessionDir,
      redacted: true,
    });
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      contextPath: path.join(sessionDir, 'context.jsonl'),
      statePath: path.join(sessionDir, 'state.json'),
      wirePath: path.join(sessionDir, 'wire.jsonl'),
      wireProtocolVersion: '1.6',
      wireRecordTypes: ['TurnBegin', 'ToolCall'],
    });
    expect(context.sessionNotes?.fidelityWarnings).toBeUndefined();
  });

  it('extracts context despite malformed lines, non-object records, and malformed tool call entries', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-malformed-context';
    const sessionId = 'malformed-context-session';

    writeKimiConfig(home, [{ path: workDirPath }]);
    const sessionDir = createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId,
      messages: [],
    });
    writeRawContext(path.join(sessionDir, 'context.jsonl'), [
      '{ this-is-not-json',
      'null',
      JSON.stringify({ role: '_system_prompt', content: 'Internal prompt should not appear.' }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Please commit the change' }] }),
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'think', think: 'Need to run the shell command next step.' },
          { type: 'think', think: '  need to run the shell command next step.  ' },
          { type: 'text', text: 'I will run it.' },
        ],
        tool_calls: [
          {
            type: 'function',
            id: 'functions.Shell:22',
            function: {
              name: 'Shell',
              arguments: '{"command":"git commit -m \\"feat: parser hardening\n\nBody line\\""}',
            },
          },
          { type: 'function', id: 'broken-call' },
          {
            type: 'function',
            id: 'functions.Strange:1',
            function: {
              name: 'StrangeTool',
              arguments: '{"path":"src/example.ts"}',
            },
          },
        ],
      }),
      JSON.stringify({ role: '_usage', token_count: 250 }),
    ]);

    const { extractKimiContext } = await loadKimiParserWithHome(home);
    const session: UnifiedSession = {
      id: sessionId,
      source: 'kimi',
      cwd: workDirPath,
      repo: '',
      lines: 6,
      bytes: fs.statSync(path.join(sessionDir, 'context.jsonl')).size,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: sessionDir,
      summary: 'Malformed context test',
    };

    const context = await extractKimiContext(session);

    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Please commit the change' },
      { role: 'assistant', content: 'I will run it.' },
    ]);
    expect(context.toolSummaries.find((summary) => summary.name === 'Shell')?.samples[0]?.summary).toContain(
      'git commit -m',
    );
    expect(context.toolSummaries.find((summary) => summary.name === 'StrangeTool')?.samples[0]?.summary).toContain(
      'src/example.ts',
    );
    expect(context.pendingTasks).toEqual(['Need to run the shell command next step.']);
    expect(context.sessionNotes?.tokenUsage).toBeUndefined();
    expect(context.sessionNotes?.rawAccess).toMatchObject({
      kind: 'directory',
      path: sessionDir,
      redacted: true,
    });
    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('wire.jsonl was not present'),
        expect.stringContaining('malformed or unsupported record'),
      ]),
    );
  });

  it('reports total context lines and dropped record count from a single streaming pass', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-single-pass-counts';
    const sessionId = 'single-pass-counts-session';

    writeKimiConfig(home, [{ path: workDirPath }]);
    const sessionDir = createKimiSession({
      homeDir: home,
      workDirPath,
      sessionId,
      messages: [],
    });
    // Mix valid + invalid + non-object + missing-role rows to exercise both
    // counters in a single pass.
    writeRawContext(path.join(sessionDir, 'context.jsonl'), [
      JSON.stringify({ role: 'user', content: 'first valid' }),
      '{ this-is-not-json',
      'null',
      JSON.stringify({ role: 'assistant', content: 'second valid' }),
      JSON.stringify({ no_role_field: true }),
    ]);

    const { extractKimiContext, parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].lines).toBe(5);

    const context = await extractKimiContext(sessions[0]);
    expect(context.sessionNotes?.sourceMetadata?.contextLines).toBe(5);
    expect(context.sessionNotes?.sourceMetadata?.contextDroppedRecords).toBe(3);
  });

  it('discovers and extracts legacy flat context jsonl files without migrating them', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const workDirPath = '/tmp/project-legacy-flat';
    const sessionId = 'legacy-flat-session';

    writeKimiConfig(home, [{ path: workDirPath }]);
    const workDirHash = md5(workDirPath);
    const workDirSessionsDir = path.join(home, '.kimi', 'sessions', workDirHash);
    fs.mkdirSync(workDirSessionsDir, { recursive: true });
    const contextPath = path.join(workDirSessionsDir, `${sessionId}.jsonl`);
    writeJsonl(contextPath, [
      { role: 'user', content: 'Read legacy flat session' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [
          {
            type: 'function',
            id: 'functions.Read:1',
            function: { name: 'Read', arguments: '{"file_path":"src/legacy.ts"}' },
          },
        ],
      },
    ]);

    const { parseKimiSessions, extractKimiContext } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe(workDirPath);
    expect(sessions[0].originalPath).toBe(contextPath);

    const context = await extractKimiContext(sessions[0]);
    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Read legacy flat session' },
      { role: 'assistant', content: 'Reading.' },
    ]);
    expect(context.toolSummaries.find((summary) => summary.name === 'Read')?.samples[0]?.summary).toBe(
      'read src/legacy.ts',
    );
    expect(context.sessionNotes?.rawAccess).toMatchObject({
      kind: 'file',
      path: contextPath,
      redacted: true,
    });
    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('legacy flat JSONL')]),
    );
  });
});

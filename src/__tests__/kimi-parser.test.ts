import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tmpHomes: string[] = [];
const originalKimiCodeHome = process.env.KIMI_CODE_HOME;
const originalKimiShareDir = process.env.KIMI_SHARE_DIR;

function writeJsonl(filePath: string, rows: unknown[]): void {
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function makeWire(opts: { userText?: string; includeToolCalls?: boolean; includeUsage?: boolean } = {}): unknown[] {
  const rows: unknown[] = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1786461111620 },
    { type: 'profile.bind', modelAlias: 'kimi-code/kimi-for-coding', profileName: 'agent' },
    {
      type: 'turn.prompt',
      input: [{ type: 'text', text: opts.userText ?? 'Do the thing' }],
      origin: { kind: 'user' },
      time: 1786461111671,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 'u1', turnId: '1', step: 1 },
      time: 1786461111678,
    },
  ];
  if (opts.includeToolCalls) {
    rows.push({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: 'u2',
        turnId: '1',
        step: 1,
        stepUuid: 'u1',
        part: { type: 'text', text: 'I will run the command.' },
      },
      time: 1786461111680,
    });
    rows.push({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        uuid: 'u3',
        turnId: '1',
        step: 1,
        stepUuid: 'u1',
        toolCallId: 'tc-001',
        name: 'Bash',
        args: { command: 'git status', cwd: '/home/user/project' },
      },
      time: 1786461111681,
    });
    rows.push({
      type: 'context.append_loop_event',
      event: { type: 'tool.result', parentUuid: 'u3', toolCallId: 'tc-001', result: { output: 'clean' } },
      time: 1786461111682,
    });
    rows.push({
      type: 'context.append_loop_event',
      event: { type: 'step.end', uuid: 'u4', turnId: '1', step: 1, finishReason: 'tool_use' },
      time: 1786461111683,
    });
  } else {
    rows.push({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        uuid: 'u2',
        turnId: '1',
        step: 1,
        stepUuid: 'u1',
        part: { type: 'text', text: 'Done.' },
      },
      time: 1786461111680,
    });
  }
  if (opts.includeUsage) {
    rows.push({
      type: 'usage.record',
      model: 'kimi-code/kimi-for-coding',
      usage: { inputOther: 100, output: 50, inputCacheRead: 10, inputCacheCreation: 0 },
      usageScope: 'turn',
      time: 1786461111684,
    });
  }
  rows.push({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 500, time: 1786461111685 });
  return rows;
}

/**
 * Create a v2-layout Kimi session under the given share dir:
 * sessions/wd_<name>_<hash>/session_<id>/ with state.json + agents/main/wire.jsonl.
 */
function createKimiV2Session(opts: {
  shareDir: string;
  sessionId: string;
  workDir: string;
  wireRows: unknown[];
  state?: Record<string, unknown>;
  wdDirName?: string;
}): { sessionDir: string; agentsMainDir: string } {
  const wdDirName = opts.wdDirName ?? `wd_test-${opts.sessionId.slice(-6)}_hash`;
  const sessionDir = path.join(opts.shareDir, 'sessions', wdDirName, opts.sessionId);
  const agentsMainDir = path.join(sessionDir, 'agents', 'main');
  fs.mkdirSync(agentsMainDir, { recursive: true });
  writeJsonl(path.join(agentsMainDir, 'wire.jsonl'), opts.wireRows);
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify(
      {
        id: opts.sessionId,
        version: 2,
        cwd: opts.workDir,
        createdAt: 1786461111564,
        updatedAt: 1786461111685,
        archived: false,
        agents: { main: { homedir: agentsMainDir, type: 'main' } },
        custom: {},
        ...(opts.state ?? {}),
      },
      null,
      2,
    ),
    'utf8',
  );
  return { sessionDir, agentsMainDir };
}

function writeSessionIndex(
  shareDir: string,
  entries: Array<{ sessionId: string; sessionDir: string; workDir: string }>,
): void {
  fs.mkdirSync(shareDir, { recursive: true });
  writeJsonl(path.join(shareDir, 'session_index.jsonl'), entries);
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
  delete process.env.KIMI_CODE_HOME;
  delete process.env.KIMI_SHARE_DIR;
});

afterEach(() => {
  vi.doUnmock('os');
  vi.doUnmock('../utils/markdown.js');
  if (originalKimiCodeHome === undefined) {
    delete process.env.KIMI_CODE_HOME;
  } else {
    process.env.KIMI_CODE_HOME = originalKimiCodeHome;
  }
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

describe('kimi parser v2', () => {
  it('uses KIMI_CODE_HOME as the primary runtime directory when set', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-home-'));
    const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-share-'));
    tmpHomes.push(home, shareDir);
    process.env.KIMI_CODE_HOME = shareDir;
    const workDirPath = '/tmp/project-share-dir';
    const sessionId = 'session_share-dir-session';

    const { sessionDir } = createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Read from configured share dir' }),
    });
    writeSessionIndex(shareDir, [{ sessionId, sessionDir, workDir: workDirPath }]);

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe(workDirPath);
    expect(sessions[0].originalPath.startsWith(shareDir)).toBe(true);
  });

  it('falls back to ~/.kimi-code when no env override is set', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-default';
    const sessionId = 'session_default-session';

    const { sessionDir } = createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Discover from default share dir' }),
    });
    writeSessionIndex(shareDir, [{ sessionId, sessionDir, workDir: workDirPath }]);

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe(workDirPath);
  });

  it('discovers sessions from the session index even when metadata is missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-no-metadata';
    const sessionId = 'session_missing-metadata-session';

    const { sessionDir } = createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Fix parser discovery' }),
    });
    writeSessionIndex(shareDir, [{ sessionId, sessionDir, workDir: workDirPath }]);

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe(workDirPath);
    expect(sessions[0].summary).toBe('Fix parser discovery');
  });

  it('falls back to scanning sessions/wd_*/session_* when the session index is missing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-no-index';
    const sessionId = 'session_no-index-session';

    createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Scan fallback discovery' }),
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe(workDirPath);
  });

  it('uses state.json cwd when available, ignoring workspaces mismatch', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-state-cwd';
    const sessionId = 'session_state-cwd-session';

    // index points at a stale workDir; state.json cwd must win
    const { sessionDir } = createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Use state cwd' }),
    });
    writeSessionIndex(shareDir, [{ sessionId, sessionDir, workDir: '/tmp/stale-workdir' }]);

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe(workDirPath);
  });

  it('resolves cwd from workspaces.json when state.json and index lack it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-workspace-root';
    const sessionId = 'session_workspace-cwd-session';
    const wdDirName = 'wd_test-workspace-cwd_hash';

    createKimiV2Session({
      shareDir,
      sessionId,
      workDir: '',
      wdDirName,
      state: { cwd: undefined },
      wireRows: makeWire({ userText: 'Resolve from workspaces' }),
    });
    fs.writeFileSync(
      path.join(shareDir, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        workspaces: { [wdDirName]: { root: workDirPath, name: 'project-workspace-root' } },
        deleted_workspace_ids: [],
      }),
    );

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe(workDirPath);
  });

  it('excludes explicitly archived sessions but keeps non-archived ones', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-archive-behavior';

    const active = createKimiV2Session({
      shareDir,
      sessionId: 'session_active-session',
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Active session should remain visible' }),
    });
    const archived = createKimiV2Session({
      shareDir,
      sessionId: 'session_archived-session',
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Archived session should be hidden' }),
      state: { archived: true },
    });
    writeSessionIndex(shareDir, [
      { sessionId: 'session_active-session', sessionDir: active.sessionDir, workDir: workDirPath },
      { sessionId: 'session_archived-session', sessionDir: archived.sessionDir, workDir: workDirPath },
    ]);

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions.map((s) => s.id)).toContain('session_active-session');
    expect(sessions.map((s) => s.id)).not.toContain('session_archived-session');
  });

  it('uses state.json title, updatedAt, and createdAt fields when present', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-state-json';
    const sessionId = 'session_state-active-session';
    const createdAtMs = 1786461111564;
    const updatedAtMs = 1786556548825;

    const wireRows: unknown[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1786461111620 },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'u1',
          turnId: '1',
          step: 1,
          stepUuid: 'u1',
          part: { type: 'text', text: 'No user title source.' },
        },
        time: 1786461111680,
      },
      { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 500, time: 1786461111685 },
    ];
    createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows,
      state: {
        title: 'State title',
        createdAt: createdAtMs,
        updatedAt: updatedAtMs,
      },
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe('State title');
    expect(sessions[0].createdAt.getTime()).toBe(createdAtMs);
    expect(sessions[0].updatedAt.getTime()).toBe(updatedAtMs);
  });

  it('derives updatedAt from wire log mtime when state.json has no updatedAt', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-wire-mtime';
    const sessionId = 'session_wire-mtime-session';

    createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Use wire mtime' }),
      state: { updatedAt: undefined, createdAt: undefined },
    });

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    const wireMtime = fs.statSync(
      path.join(shareDir, 'sessions', `wd_test-${sessionId.slice(-6)}_hash`, sessionId, 'agents', 'main', 'wire.jsonl'),
    ).mtime;
    expect(sessions[0].updatedAt.getTime()).toBe(wireMtime.getTime());
  });

  it('exposes model from profile.bind and wire/state metadata during extraction', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/Users/alice/example-repo';
    const sessionId = 'session_wire-metadata-session';

    const { sessionDir } = createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: makeWire({ includeToolCalls: true }),
      state: { title: 'Wire metadata' },
    });
    writeSessionIndex(shareDir, [{ sessionId, sessionDir, workDir: workDirPath }]);

    const { parseKimiSessions, extractKimiContext } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();
    const session = sessions[0];
    const context = await extractKimiContext(session);

    expect(session.model).toBe('kimi-code/kimi-for-coding');
    expect(session.repo).toBe('alice/example-repo');
    expect(context.sessionNotes?.rawAccess).toMatchObject({
      kind: 'directory',
      path: sessionDir,
      redacted: true,
    });
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      shareDir,
      wirePath: path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      statePath: path.join(sessionDir, 'state.json'),
      wireProtocolVersion: '1.5',
      wireRecordTypes: expect.arrayContaining([
        'metadata',
        'profile.bind',
        'turn.prompt',
        'turn.ended',
        'content.part',
        'tool.call',
      ]),
    });
    expect(context.sessionNotes?.fidelityWarnings).toBeUndefined();
  });

  it('extracts context despite malformed lines, non-object records, and tool calls with object args', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-malformed-wire';
    const sessionId = 'session_malformed-wire-session';

    const rows: unknown[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1786461111620 },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'Please commit the change' }],
        origin: { kind: 'user' },
        time: 1786461111671,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'u2',
          turnId: '1',
          step: 1,
          stepUuid: 'u1',
          part: { type: 'think', think: 'Need to run the shell command next step.' },
        },
        time: 1786461111680,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'u3',
          turnId: '1',
          step: 1,
          stepUuid: 'u1',
          part: { type: 'text', text: 'I will run it.' },
        },
        time: 1786461111681,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'u4',
          turnId: '1',
          step: 1,
          stepUuid: 'u1',
          toolCallId: 'tc-001',
          name: 'Shell',
          args: { command: 'git commit -m "feat: parser hardening"' },
        },
        time: 1786461111682,
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', uuid: 'u5', turnId: '1', step: 1, finishReason: 'tool_use' },
        time: 1786461111683,
      },
      {
        type: 'usage.record',
        model: 'kimi-code/kimi-for-coding',
        usage: { inputOther: 100, output: 50 },
        usageScope: 'turn',
        time: 1786461111684,
      },
      { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 500, time: 1786461111685 },
    ];

    createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: rows,
    });
    const wirePath = path.join(
      shareDir,
      'sessions',
      `wd_test-${sessionId.slice(-6)}_hash`,
      sessionId,
      'agents',
      'main',
      'wire.jsonl',
    );
    // Append malformed lines to exercise dropped-record counting
    fs.appendFileSync(wirePath, '{ this-is-not-json\nnull\n', 'utf8');

    const { parseKimiSessions, extractKimiContext } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].lines).toBe(10);

    const context = await extractKimiContext(sessions[0]);
    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Please commit the change' },
      { role: 'assistant', content: 'I will run it.' },
    ]);
    expect(context.toolSummaries.find((summary) => summary.name === 'Shell')?.samples[0]?.summary).toContain(
      'git commit -m',
    );
    expect(context.pendingTasks).toEqual(['Need to run the shell command next step.']);
    expect(context.sessionNotes?.tokenUsage).toBeUndefined();
    expect(context.sessionNotes?.rawAccess).toMatchObject({
      kind: 'directory',
      path: path.dirname(path.dirname(path.dirname(wirePath))),
      redacted: true,
    });
    expect(context.sessionNotes?.sourceMetadata?.wireDroppedRecords).toBe(2);
  });

  it('reports a fidelity warning when the wire log records a full compaction', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-compaction';
    const sessionId = 'session_compaction-session';

    const rows: unknown[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1786461111620 },
      { type: 'full_compaction.begin', source: 'manual', time: 1786461112000 },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'Continue after compaction' }],
        origin: { kind: 'user' },
        time: 1786461113000,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'u1',
          turnId: '2',
          step: 1,
          stepUuid: 'u1',
          part: { type: 'text', text: 'Continuing.' },
        },
        time: 1786461113100,
      },
      { type: 'turn.ended', turnId: 2, reason: 'completed', durationMs: 500, time: 1786461113200 },
    ];

    createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: rows,
    });

    const { parseKimiSessions, extractKimiContext } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();
    const context = await extractKimiContext(sessions[0]);

    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('compaction')]),
    );
  });

  it('skips task-origin and injection turn prompts when reconstructing conversation', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-origin-filter';
    const sessionId = 'session_origin-filter-session';

    const rows: unknown[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1786461111620 },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'Real user turn' }],
        origin: { kind: 'user' },
        time: 1786461111671,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: '<notification id="task:x:completed">done</notification>' }],
        origin: { kind: 'task', taskId: 'x', status: 'completed' },
        time: 1786461111800,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'injection' }],
          origin: { kind: 'injection', variant: 'interruption' },
        },
        time: 1786461111850,
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'u1',
          turnId: '1',
          step: 1,
          stepUuid: 'u1',
          part: { type: 'text', text: 'Acknowledged.' },
        },
        time: 1786461111900,
      },
      { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 500, time: 1786461112000 },
    ];

    createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: rows,
    });

    const { parseKimiSessions, extractKimiContext } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();
    const context = await extractKimiContext(sessions[0]);

    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Real user turn' },
      { role: 'assistant', content: 'Acknowledged.' },
    ]);
  });

  it('keeps legacy ~/.kimi md5-layout sessions discoverable via KIMI_SHARE_DIR', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi');
    const workDirPath = '/tmp/project-legacy';
    const sessionId = 'legacy-session-1';
    const workDirHash = createHash('md5').update(workDirPath, 'utf8').digest('hex');
    const hashDir = path.join(shareDir, 'sessions', workDirHash, sessionId);
    fs.mkdirSync(hashDir, { recursive: true });
    writeJsonl(path.join(hashDir, 'context.jsonl'), [
      { role: 'user', content: 'Read legacy session' },
      { role: 'assistant', content: 'Reading.' },
    ]);
    fs.writeFileSync(path.join(shareDir, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workDirPath }] }), 'utf8');

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].cwd).toBe(workDirPath);
  });

  it('reports empty sessions and unreadable dirs without crashing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-empty';

    // Session with no wire log at all
    const emptyDir = path.join(shareDir, 'sessions', 'wd_empty_hash', 'session_empty-session');
    fs.mkdirSync(path.join(emptyDir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(
      path.join(emptyDir, 'state.json'),
      JSON.stringify({
        id: 'session_empty-session',
        version: 2,
        cwd: workDirPath,
        agents: { main: { homedir: path.join(emptyDir, 'agents', 'main'), type: 'main' } },
      }),
    );
    fs.writeFileSync(path.join(emptyDir, 'agents', 'main', 'wire.jsonl'), '', 'utf8');

    const { parseKimiSessions } = await loadKimiParserWithHome(home);
    const sessions = await parseKimiSessions();

    expect(sessions).toHaveLength(0);
  });

  it('builds a session from raw UnifiedSession without re-scanning the index', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-parser-'));
    tmpHomes.push(home);
    const shareDir = path.join(home, '.kimi-code');
    const workDirPath = '/tmp/project-direct-extract';
    const sessionId = 'session_direct-extract-session';

    const { sessionDir } = createKimiV2Session({
      shareDir,
      sessionId,
      workDir: workDirPath,
      wireRows: makeWire({ userText: 'Direct extraction' }),
    });

    const { extractKimiContext } = await loadKimiParserWithHome(home);
    const session: UnifiedSession = {
      id: sessionId,
      source: 'kimi',
      cwd: workDirPath,
      repo: '',
      lines: 1,
      bytes: fs.statSync(path.join(sessionDir, 'agents', 'main', 'wire.jsonl')).size,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: sessionDir,
      summary: 'Direct test',
    };

    const context = await extractKimiContext(session);
    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Direct extraction' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});

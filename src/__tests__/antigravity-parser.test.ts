import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

// Spawn is hand-mocked so we can assert when/with-what `tryAutoLaunchAndConnect`
// shells out, without ever launching the real Antigravity IDE during tests.
// `.on` is also stubbed because spawnAntigravity attaches an async 'error'
// listener so an asynchronously-emitted ENOENT (missing-binary) doesn't crash
// the cli — without `.on` the spy would throw and make spawn appear to fail.
type FakeChild = {
  unref: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};
const fakeChildProcess: FakeChild = {
  unref: vi.fn(),
  on: vi.fn(() => fakeChildProcess as unknown as import('node:child_process').ChildProcess),
};
const spawnMock = vi.fn(() => fakeChildProcess as unknown as import('node:child_process').ChildProcess);

// execFile is wrapped so tests can either let it pass through to the real impl
// (default) or stub it to simulate "no Antigravity processes visible to ps",
// which is how we exercise the polling timeout path on machines that may have
// a real Antigravity language_server running locally.
let execFileOverride: typeof import('node:child_process').execFile | undefined;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const wrappedExecFile = ((...args: unknown[]) => {
    const target = execFileOverride ?? actual.execFile;
    return (target as (...a: unknown[]) => unknown)(...args);
  }) as typeof import('node:child_process').execFile;
  return { ...actual, spawn: spawnMock, execFile: wrappedExecFile };
});

const { extractAntigravityContext, parseAntigravitySessions } = await import('../parsers/antigravity.js');

interface SqlitePreparedStatement {
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-antigravity-'));
  tempRoots.push(root);
  vi.stubEnv('ANTIGRAVITY_HOME', root);
  vi.stubEnv('ANTIGRAVITY_STATE_DB', path.join(root, 'missing-state.vscdb'));
  vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '1');
  return root;
}

function writeFile(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function fieldVarint(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([writeVarint(fieldNumber << 3), writeVarint(value)]);
}

function fieldBytes(fieldNumber: number, bytes: Buffer): Buffer {
  return Buffer.concat([writeVarint((fieldNumber << 3) | 2), writeVarint(bytes.length), bytes]);
}

function timestampMessage(date: Date): Buffer {
  return Buffer.concat([fieldVarint(1, Math.floor(date.getTime() / 1000)), fieldVarint(2, 0)]);
}

function buildTrajectorySummariesValue(opts: {
  id: string;
  title: string;
  cwd: string;
  createdAt: Date;
  updatedAt: Date;
  stepCount: number;
}): string {
  const summaryProto = Buffer.concat([
    fieldBytes(1, Buffer.from(opts.title)),
    fieldVarint(2, opts.stepCount),
    fieldBytes(3, timestampMessage(opts.createdAt)),
    fieldBytes(7, timestampMessage(opts.updatedAt)),
    fieldBytes(9, Buffer.from(`file://${opts.cwd}`)),
  ]);
  const storedSummary = fieldBytes(1, Buffer.from(summaryProto.toString('base64')));
  const mapEntry = Buffer.concat([fieldBytes(1, Buffer.from(opts.id)), fieldBytes(2, storedSummary)]);
  return fieldBytes(1, mapEntry).toString('base64');
}

function createStateDb(dbPath: string, key: string, value: string): void {
  const sqliteModule = require('node:sqlite') as {
    DatabaseSync: new (database: string) => SqliteDatabase;
  };
  const db = new sqliteModule.DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(key, value);
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  spawnMock.mockClear();
  spawnMock.mockImplementation(() => fakeChildProcess as unknown as import('node:child_process').ChildProcess);
  fakeChildProcess.unref.mockClear();
  fakeChildProcess.on.mockClear();
  fakeChildProcess.on.mockImplementation(
    () => fakeChildProcess as unknown as import('node:child_process').ChildProcess,
  );
  execFileOverride = undefined;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Stub execFile to behave as if no processes match — i.e., `ps` and `lsof` both
// return empty stdout. This forces findRpcConnection() to return null
// regardless of what's actually running on the host, exercising the polling
// timeout path deterministically.
function stubExecFileEmpty(): void {
  execFileOverride = ((_file: unknown, _args: unknown, _options: unknown, callback: unknown) => {
    if (typeof callback === 'function') {
      (callback as (err: Error | null, stdout: string, stderr: string) => void)(null, '', '');
    }
    return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>;
  }) as typeof import('node:child_process').execFile;
}

// Stub execFile so that `ps` reports a single fake antigravity language_server
// row and `lsof` reports a matching listening port. This lets us simulate the
// "rpc already alive" precondition deterministically without touching the host
// process table.
function stubExecFileLiveRpc(opts: { port: number; csrfToken: string }): void {
  const psLine = `12345 /opt/antigravity/bin/language_server_linux --csrf_token ${opts.csrfToken} --server_port ${opts.port} --app_data_dir antigravity\n`;
  const lsofLine = `language_ 12345 user 7u IPv4 0t0 TCP 127.0.0.1:${opts.port} (LISTEN)\n`;
  execFileOverride = ((file: unknown, _args: unknown, _options: unknown, callback: unknown) => {
    if (typeof callback === 'function') {
      const send = callback as (err: Error | null, stdout: string, stderr: string) => void;
      if (file === 'ps') send(null, psLine, '');
      else if (file === 'lsof') send(null, lsofLine, '');
      else send(null, '', '');
    }
    return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>;
  }) as typeof import('node:child_process').execFile;
}

function setStdoutTty(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  });
}

function setProcessPlatform(value: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value });
  return () => Object.defineProperty(process, 'platform', { configurable: true, value: original });
}

describe('Antigravity parser', () => {
  it('discovers pb and brain sessions while ignoring snapshot-only code_tracker JSON', async () => {
    const root = makeRoot();
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x01]));
    writeFile(
      path.join(root, 'brain', id, 'task.md.resolved.0'),
      '# Task: Fix auth bug\n\nWorkspace: file:///home/user/project\n\n- [ ] Add regression tests\n',
    );
    writeFile(path.join(root, 'brain', id, 'implementation_plan.md'), '# Plan\n\n- [ ] Update login.ts validation\n');
    writeFile(path.join(root, 'code_tracker', 'active', 'snapshot.json'), JSON.stringify({ path: 'login.ts' }));

    const sessions = await parseAntigravitySessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id,
      source: 'antigravity',
      cwd: '/home/user/project',
      repo: 'user/project',
      summary: 'Task: Fix auth bug',
      originalPath: path.join(root, 'conversations', `${id}.pb`),
    });
  });

  it('uses state.vscdb trajectory summaries for title, cwd, timestamps, and step count', async () => {
    const root = makeRoot();
    const id = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const dbPath = path.join(root, 'state.vscdb');
    const createdAt = new Date('2026-01-15T10:00:00.000Z');
    const updatedAt = new Date('2026-01-15T10:05:00.000Z');

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x02]));
    createStateDb(
      dbPath,
      'antigravityUnifiedStateSync.trajectorySummaries',
      buildTrajectorySummariesValue({
        id,
        title: 'Investigate Antigravity storage',
        cwd: '/home/user/project',
        createdAt,
        updatedAt,
        stepCount: 7,
      }),
    );
    vi.stubEnv('ANTIGRAVITY_STATE_DB', dbPath);

    const sessions = await parseAntigravitySessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toBe('Investigate Antigravity storage');
    expect(sessions[0].cwd).toBe('/home/user/project');
    expect(sessions[0].lines).toBe(7);
    expect(sessions[0].createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(sessions[0].updatedAt.toISOString()).toBe(updatedAt.toISOString());
  });

  it('extracts an offline handoff from brain artifacts when live RPC is unavailable', async () => {
    const root = makeRoot();
    const id = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x03]));
    writeFile(path.join(root, 'brain', id, 'task.md'), '# Task: Fix login\n\n- [ ] Add validation tests\n');
    writeFile(path.join(root, 'brain', id, 'implementation_plan.md'), '# Plan\n\n- [ ] Patch login.ts\n');
    writeFile(path.join(root, 'brain', id, 'walkthrough.md'), '# Walkthrough\n\nValidation was inspected.\n');

    const [session] = await parseAntigravitySessions();
    const context = await extractAntigravityContext(session);

    expect(context.recentMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(context.recentMessages[0].content).toContain('Task: Fix login');
    expect(context.pendingTasks).toEqual(['Add validation tests', 'Patch login.ts']);
    expect(context.sessionNotes?.compactSummary).toContain('Full raw transcript extraction requires');
    expect(context.markdown).toContain('Implementation plan');
  });

  it('does not auto-launch the IDE when CONTINUES_LAUNCH_ANTIGRAVITY=0 even on an interactive TTY', async () => {
    const root = makeRoot();
    const id = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    // Put an empty brain folder so the offline path also yields no transcript —
    // mirroring real sessions whose .pb is encrypted and brain artifacts never landed.
    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x04]));
    fs.mkdirSync(path.join(root, 'brain', id), { recursive: true });

    // Re-enable the RPC code path so the launch gate is the only thing keeping
    // us offline, then disable launch explicitly. Force an interactive TTY so
    // the only thing that could suppress spawn is the env-var gate itself.
    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '0');
    setStdoutTty(true);

    const [session] = await parseAntigravitySessions();
    const context = await extractAntigravityContext(session);

    expect(context.recentMessages).toEqual([]);
    expect(context.sessionNotes?.compactSummary).toContain('running Antigravity language server');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not auto-launch the IDE when stdout is not a TTY (default piped/CI behavior)', async () => {
    const root = makeRoot();
    const id = 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x05]));
    fs.mkdirSync(path.join(root, 'brain', id), { recursive: true });

    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    // Leave CONTINUES_LAUNCH_ANTIGRAVITY unset — the TTY gate must hold by itself.
    setStdoutTty(false);

    const [session] = await parseAntigravitySessions();
    const context = await extractAntigravityContext(session);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(context.recentMessages).toEqual([]);
  });

  it('does not auto-launch when ANTIGRAVITY_DISABLE_RPC=1 even with CONTINUES_LAUNCH_ANTIGRAVITY=1', async () => {
    const root = makeRoot();
    const id = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x06]));
    fs.mkdirSync(path.join(root, 'brain', id), { recursive: true });

    // ANTIGRAVITY_DISABLE_RPC=1 is the legacy escape hatch. Even with launch
    // force-enabled and a real TTY, the disable flag must short-circuit
    // shouldAutoLaunchAntigravity() before any spawn happens.
    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '1');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '1');
    setStdoutTty(true);

    const [session] = await parseAntigravitySessions();
    const context = await extractAntigravityContext(session);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(context.recentMessages).toEqual([]);
  });

  it('auto-launches with detached/unref on darwin when CONTINUES_LAUNCH_ANTIGRAVITY=1 even without a TTY', async () => {
    const root = makeRoot();
    const id = '11111111-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x07]));
    fs.mkdirSync(path.join(root, 'brain', id), { recursive: true });

    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '1');
    // Cap the polling loop so the test cannot stall for the 25s production ceiling.
    vi.stubEnv('CONTINUES_LAUNCH_TIMEOUT_MS', '50');
    vi.stubEnv('CONTINUES_LAUNCH_POLL_INTERVAL_MS', '20');
    setStdoutTty(false);
    // Force findRpcConnection() to return null so we definitively exercise the
    // launch path rather than connecting to a real Antigravity that may be
    // running on the host machine.
    stubExecFileEmpty();
    const restorePlatform = setProcessPlatform('darwin');

    try {
      const [session] = await parseAntigravitySessions();
      const context = await extractAntigravityContext(session);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [file, args, options] = spawnMock.mock.calls[0] as unknown as [
        string,
        string[],
        { detached?: boolean; stdio?: string },
      ];
      expect(file).toBe('open');
      expect(args).toEqual(['-a', 'Antigravity']);
      expect(options.detached).toBe(true);
      expect(options.stdio).toBe('ignore');
      expect(fakeChildProcess.unref).toHaveBeenCalledTimes(1);
      // findRpcConnection still returns null in the test environment, so we
      // expect the polling loop to time out and the offline fallback to win.
      expect(context.recentMessages).toEqual([]);
      expect(context.sessionNotes?.compactSummary).toContain('running Antigravity language server');
    } finally {
      restorePlatform();
    }
  });

  it('uses cmd.exe to launch Antigravity on win32', async () => {
    const root = makeRoot();
    const id = '22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x08]));
    fs.mkdirSync(path.join(root, 'brain', id), { recursive: true });

    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '1');
    vi.stubEnv('CONTINUES_LAUNCH_TIMEOUT_MS', '50');
    vi.stubEnv('CONTINUES_LAUNCH_POLL_INTERVAL_MS', '20');
    setStdoutTty(false);
    stubExecFileEmpty();
    const restorePlatform = setProcessPlatform('win32');

    try {
      const [session] = await parseAntigravitySessions();
      await extractAntigravityContext(session);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [file, args, options] = spawnMock.mock.calls[0] as unknown as [string, string[], { detached?: boolean }];
      expect(file).toBe('cmd');
      // `start "" antigravity` — the empty title arg is required so cmd.exe does
      // not interpret a quoted command as the window title.
      expect(args).toEqual(['/c', 'start', '', 'antigravity']);
      expect(options.detached).toBe(true);
      expect(fakeChildProcess.unref).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  it('uses the antigravity binary directly on linux/other platforms', async () => {
    const root = makeRoot();
    const id = '33333333-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x09]));
    fs.mkdirSync(path.join(root, 'brain', id), { recursive: true });

    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '1');
    vi.stubEnv('CONTINUES_LAUNCH_TIMEOUT_MS', '50');
    vi.stubEnv('CONTINUES_LAUNCH_POLL_INTERVAL_MS', '20');
    setStdoutTty(false);
    stubExecFileEmpty();
    const restorePlatform = setProcessPlatform('linux');

    try {
      const [session] = await parseAntigravitySessions();
      await extractAntigravityContext(session);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [file, args, options] = spawnMock.mock.calls[0] as unknown as [string, string[], { detached?: boolean }];
      expect(file).toBe('antigravity');
      expect(args).toEqual([]);
      expect(options.detached).toBe(true);
      expect(fakeChildProcess.unref).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  it('does not spawn the IDE when findRpcConnection is already alive but the cascade has no live steps', async () => {
    // Regression for the preflight-rpc-check fix: extractLiveContext returns
    // null both when (a) the language_server is down and (b) it's up but holds
    // no steps for this cascadeId. launching the ide can only help case (a);
    // in case (b) it would just bounce the user's dock for nothing. tryAutoLaunchAndConnect
    // must short-circuit when findRpcConnection() returns a live connection.
    const root = makeRoot();
    const id = '77777777-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x0d]));
    writeFile(path.join(root, 'brain', id, 'task.md'), '# Task: Already-alive RPC\n\n- [ ] Investigate\n');

    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '1');
    vi.stubEnv('CONTINUES_LAUNCH_TIMEOUT_MS', '50');
    vi.stubEnv('CONTINUES_LAUNCH_POLL_INTERVAL_MS', '20');
    setStdoutTty(false);
    // ps + lsof return a fake live language_server. callRpc will fail (no real
    // listener on this port) so extractLiveContext yields null — exactly the
    // shape that used to trigger a redundant ide launch before the fix.
    stubExecFileLiveRpc({ port: 4242, csrfToken: 'fake-token' });

    const [session] = await parseAntigravitySessions();
    const context = await extractAntigravityContext(session);

    // The preflight check inside tryAutoLaunchAndConnect saw the live RPC and
    // declined to spawn. We end up in the offline brain-artifact fallback.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(context.recentMessages.length).toBeGreaterThan(0);
    expect(context.recentMessages[0].content).toContain('Already-alive RPC');
  });

  it('falls back to offline gracefully when spawn throws (e.g. binary missing)', async () => {
    const root = makeRoot();
    const id = '44444444-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x0a]));
    writeFile(path.join(root, 'brain', id, 'task.md'), '# Task: Recover transcript\n\n- [ ] Investigate\n');

    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '1');
    vi.stubEnv('CONTINUES_LAUNCH_TIMEOUT_MS', '50');
    vi.stubEnv('CONTINUES_LAUNCH_POLL_INTERVAL_MS', '20');
    setStdoutTty(false);
    stubExecFileEmpty();

    spawnMock.mockImplementationOnce(() => {
      throw new Error('ENOENT: open');
    });

    const [session] = await parseAntigravitySessions();
    // The promise must resolve — a spawn failure must NOT throw out of extractAntigravityContext.
    const context = await extractAntigravityContext(session);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(context.recentMessages.length).toBeGreaterThan(0);
    expect(context.recentMessages[0].content).toContain('Task: Recover transcript');
  });

  it('attaches an async error listener so a missing-binary ENOENT cannot crash the cli', async () => {
    // Regression for the spawn-error-handler bug: node emits launch failures
    // on the async 'error' event, not synchronously. without a listener those
    // become uncaught exceptions and crash the cli. asserting that
    // spawnAntigravity registers a handler — and that the handler swallows
    // the error rather than rethrowing — is the verifiable signal that the
    // hardened-spawn behavior is in place.
    const root = makeRoot();
    const id = '66666666-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x0c]));
    fs.mkdirSync(path.join(root, 'brain', id), { recursive: true });

    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '1');
    vi.stubEnv('CONTINUES_LAUNCH_TIMEOUT_MS', '50');
    vi.stubEnv('CONTINUES_LAUNCH_POLL_INTERVAL_MS', '20');
    setStdoutTty(false);
    stubExecFileEmpty();

    const [session] = await parseAntigravitySessions();
    await extractAntigravityContext(session);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fakeChildProcess.on).toHaveBeenCalledWith('error', expect.any(Function));

    // Now simulate an asynchronous ENOENT — the listener must absorb it.
    const errorCalls = fakeChildProcess.on.mock.calls.filter((call) => call[0] === 'error');
    expect(errorCalls.length).toBeGreaterThan(0);
    const handler = errorCalls[0][1] as (err: Error) => void;
    expect(() => {
      handler(new Error('ENOENT: spawn open'));
    }).not.toThrow();
  });

  it('returns within the configured launch timeout when findRpcConnection never resolves', async () => {
    const root = makeRoot();
    const id = '55555555-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    writeFile(path.join(root, 'conversations', `${id}.pb`), Buffer.from([0x08, 0x0b]));
    fs.mkdirSync(path.join(root, 'brain', id), { recursive: true });

    vi.stubEnv('ANTIGRAVITY_DISABLE_RPC', '');
    vi.stubEnv('CONTINUES_LAUNCH_ANTIGRAVITY', '1');
    vi.stubEnv('CONTINUES_LAUNCH_TIMEOUT_MS', '120');
    vi.stubEnv('CONTINUES_LAUNCH_POLL_INTERVAL_MS', '40');
    setStdoutTty(false);
    // Force findRpcConnection() to always return null even on machines where
    // a real Antigravity language_server is running — we are testing the
    // polling-timeout path specifically, not host process discovery.
    stubExecFileEmpty();

    const [session] = await parseAntigravitySessions();
    const start = Date.now();
    const context = await extractAntigravityContext(session);
    const elapsed = Date.now() - start;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The polling ceiling is 120ms, plus a small fixed setup cost for parsing.
    // 6_000ms gives huge slack on slow CI while still proving the loop
    // terminates rather than hanging at the 25s production ceiling.
    expect(elapsed).toBeLessThan(6_000);
    // And tighter — within roughly the 120ms timeout plus a few hundred ms of
    // overhead. If the timeout were ignored, we would wait 25_000ms by default.
    expect(elapsed).toBeLessThan(2_000);
    expect(context.recentMessages).toEqual([]);
    expect(context.sessionNotes?.compactSummary).toContain('running Antigravity language server');
  });

  it('keeps legacy JSONL support only for chat-shaped code_tracker files', async () => {
    const root = makeRoot();
    const legacyFile = path.join(root, 'code_tracker', 'project', 'session.jsonl');

    writeFile(
      legacyFile,
      [
        JSON.stringify({ type: 'user', content: 'Fix the authentication bug', timestamp: '2026-01-15T10:00:00Z' }),
        JSON.stringify({ type: 'assistant', content: 'I found the issue.', timestamp: '2026-01-15T10:01:00Z' }),
      ].join('\n'),
    );
    writeFile(path.join(root, 'code_tracker', 'project', 'snapshot.json'), JSON.stringify({ file: 'login.ts' }));

    const sessions = await parseAntigravitySessions();
    const context = await extractAntigravityContext(sessions[0]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('legacy:project:session');
    expect(context.recentMessages).toHaveLength(2);
    expect(context.recentMessages[0].content).toBe('Fix the authentication bug');
  });
});

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractAntigravityContext, parseAntigravitySessions } from '../parsers/antigravity.js';

const require = createRequire(import.meta.url);

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
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

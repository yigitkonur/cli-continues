import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tmpDirs: string[] = [];

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-parser-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function makeRows(opts: { id: string; first: string; last: string; cwd: string }): unknown[] {
  return [
    {
      type: 'user',
      uuid: `${opts.id}-user`,
      timestamp: opts.first,
      sessionId: opts.id,
      cwd: opts.cwd,
      gitBranch: 'main',
      message: { role: 'user', content: [{ type: 'text', text: `Start ${opts.id}` }] },
    },
    {
      type: 'assistant',
      uuid: `${opts.id}-assistant`,
      timestamp: opts.last,
      sessionId: opts.id,
      cwd: opts.cwd,
      gitBranch: 'main',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'This assistant response is intentionally long enough to keep the fixture above the parser size filter.',
          },
        ],
      },
    },
  ];
}

async function loadClaudeParser(configDir: string): Promise<typeof import('../parsers/claude.js')> {
  vi.resetModules();
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  return import('../parsers/claude.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('claude parser hardening', () => {
  it('normalizes Windows cwd paths for direct Claude project lookup', async () => {
    const configDir = makeConfigDir();
    const id = '33333333-3333-4333-8333-333333333333';
    const cwd = 'C:\\Users\\me\\my.project';
    const projectDir = path.join(configDir, 'projects', 'C-Users-me-my-project');
    writeJsonl(
      path.join(projectDir, `${id}.jsonl`),
      makeRows({ id, first: '2026-04-15T10:00:00.000Z', last: '2026-04-15T10:05:00.000Z', cwd }),
    );

    const { claudeProjectSlugFromCwd, parseClaudeSessions } = await loadClaudeParser(configDir);
    const sessions = await parseClaudeSessions({ cwd, lightweight: true });

    expect(claudeProjectSlugFromCwd(cwd)).toBe('C-Users-me-my-project');
    expect(sessions.map((session) => session.id)).toContain(id);
  });

  it('orders sessions by transcript timestamps instead of filesystem mtime', async () => {
    const configDir = makeConfigDir();
    const projectDir = path.join(configDir, 'projects', '-tmp-claude-project');
    const olderId = '11111111-1111-4111-8111-111111111111';
    const newerId = '22222222-2222-4222-8222-222222222222';
    const olderPath = path.join(projectDir, `${olderId}.jsonl`);
    const newerPath = path.join(projectDir, `${newerId}.jsonl`);

    writeJsonl(
      olderPath,
      makeRows({
        id: olderId,
        first: '2026-04-15T10:00:00.000Z',
        last: '2026-04-15T10:05:00.000Z',
        cwd: '/tmp/claude-project',
      }),
    );
    writeJsonl(
      newerPath,
      makeRows({
        id: newerId,
        first: '2026-04-15T11:00:00.000Z',
        last: '2026-04-15T11:30:00.000Z',
        cwd: '/tmp/claude-project',
      }),
    );

    fs.utimesSync(olderPath, new Date('2026-04-15T12:00:00.000Z'), new Date('2026-04-15T12:00:00.000Z'));
    fs.utimesSync(newerPath, new Date('2026-04-15T09:00:00.000Z'), new Date('2026-04-15T09:00:00.000Z'));

    const { parseClaudeSessions } = await loadClaudeParser(configDir);
    const sessions = await parseClaudeSessions();

    expect(sessions[0].id).toBe(newerId);
    expect(sessions[0].updatedAt.toISOString()).toBe('2026-04-15T11:30:00.000Z');
    expect(sessions[1].id).toBe(olderId);
  });

  it('keeps Claude local-command and meta records out of conversation while preserving metadata', async () => {
    const configDir = makeConfigDir();
    const id = '44444444-4444-4444-8444-444444444444';
    const cwd = '/tmp/claude-project';
    const projectDir = path.join(configDir, 'projects', '-tmp-claude-project');
    const filePath = path.join(projectDir, `${id}.jsonl`);
    writeJsonl(filePath, [
      {
        type: 'permission-mode',
        uuid: `${id}-permission`,
        timestamp: '2026-04-15T10:00:03.000Z',
        sessionId: id,
        cwd,
        permissionMode: 'bypassPermissions',
      },
      {
        type: 'user',
        uuid: `${id}-local-command`,
        parentUuid: `${id}-permission`,
        timestamp: '2026-04-15T10:00:01.000Z',
        sessionId: id,
        cwd,
        isMeta: true,
        version: '1.2.3',
        entrypoint: 'cli',
        userType: 'external',
        message: {
          role: 'user',
          content:
            '<command-name>/plugin</command-name><command-message>plugin</command-message><command-args></command-args>',
        },
      },
      {
        type: 'user',
        uuid: `${id}-local-stdout`,
        parentUuid: `${id}-local-command`,
        timestamp: '2026-04-15T10:00:01.001Z',
        sessionId: id,
        cwd,
        message: {
          role: 'user',
          content: '<local-command-stdout>ok</local-command-stdout>',
        },
      },
      {
        type: 'file-history-snapshot',
        messageId: `${id}-snapshot-message`,
        snapshot: {
          messageId: `${id}-snapshot-message`,
          trackedFileBackups: {
            'src/parser.ts': { hash: 'abc123' },
          },
          timestamp: '2026-04-15T10:00:04.000Z',
        },
        isSnapshotUpdate: false,
      },
      {
        type: 'user',
        uuid: `${id}-user`,
        timestamp: '2026-04-15T10:00:02.000Z',
        sessionId: id,
        cwd,
        message: { role: 'user', content: [{ type: 'text', text: 'Implement the parser repair' }] },
      },
      {
        type: 'assistant',
        uuid: `${id}-assistant`,
        parentUuid: `${id}-user`,
        timestamp: '2026-04-15T10:00:05.000Z',
        sessionId: id,
        cwd,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Parser repair complete with metadata preserved.' }],
        },
      },
    ]);

    const { parseClaudeSessions, extractClaudeContext } = await loadClaudeParser(configDir);
    const [session] = await parseClaudeSessions();
    const context = await extractClaudeContext(session);

    expect(session.createdAt.toISOString()).toBe('2026-04-15T10:00:01.000Z');
    expect(session.updatedAt.toISOString()).toBe('2026-04-15T10:00:05.000Z');
    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Implement the parser repair',
      'Parser repair complete with metadata preserved.',
    ]);
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      permissionMode: 'bypassPermissions',
      version: '1.2.3',
      entrypoint: 'cli',
      userType: 'external',
      messageGraphSeen: true,
    });
    expect(context.sessionNotes?.bootstrap).toMatchObject([
      {
        type: 'local_command',
        content: 'plugin',
        metadata: {
          commandName: '/plugin',
          commandMessage: 'plugin',
          uuid: `${id}-local-command`,
          parentUuid: `${id}-permission`,
        },
      },
      {
        type: 'local_command',
        content: 'ok',
        metadata: {
          uuid: `${id}-local-stdout`,
          parentUuid: `${id}-local-command`,
        },
      },
    ]);
    expect(context.sessionNotes?.fileHistorySnapshots).toEqual([
      {
        timestamp: '2026-04-15T10:00:04.000Z',
        metadata: {
          messageId: `${id}-snapshot-message`,
          snapshotMessageId: `${id}-snapshot-message`,
          isSnapshotUpdate: false,
          trackedFileBackupsCount: 1,
        },
      },
    ]);
    expect(context.markdown).not.toContain('local-command-stdout');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tmpDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-parser-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, rows: unknown[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

function makeRows(opts: { id: string; cwd?: string; first?: string; last?: string; fillerCount?: number }): unknown[] {
  const fillerCount = opts.fillerCount ?? 0;
  return [
    {
      type: 'session_start',
      id: opts.id,
      title: 'Droid parser regression',
      sessionTitle: 'Droid parser regression',
      cwd: opts.cwd ?? '/tmp/droid-project',
    },
    {
      type: 'message',
      id: `${opts.id}-first`,
      timestamp: opts.first ?? '2026-04-15T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Patch Droid parser' }] },
    },
    ...Array.from({ length: fillerCount }, (_, index) => ({
      type: 'message',
      id: `${opts.id}-filler-${index}`,
      timestamp: `2026-04-15T10:01:${String(index % 60).padStart(2, '0')}.000Z`,
      message: { role: 'assistant', content: [{ type: 'text', text: `filler ${index}` }] },
    })),
    {
      type: 'message',
      id: `${opts.id}-last`,
      timestamp: opts.last ?? '2026-04-15T10:05:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    },
  ];
}

async function loadDroidParser(home: string): Promise<typeof import('../parsers/droid.js')> {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  return import('../parsers/droid.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('droid parser hardening', () => {
  it('discovers sessions from .factory/projects', async () => {
    const home = makeHome();
    const id = '11111111-1111-4111-8111-111111111111';
    writeJsonl(path.join(home, '.factory', 'projects', 'tmp-droid-project', `${id}.jsonl`), makeRows({ id }));

    const { parseDroidSessions } = await loadDroidParser(home);
    const sessions = await parseDroidSessions();

    expect(sessions.map((session) => session.id)).toContain(id);
    expect(sessions[0].originalPath).toContain(path.join('.factory', 'projects'));
  });

  it('dedupes the same session id across projects and sessions, preferring projects on timestamp ties', async () => {
    const home = makeHome();
    const id = '22222222-2222-4222-8222-222222222222';
    const rows = makeRows({ id, last: '2026-04-15T10:05:00.000Z' });
    writeJsonl(path.join(home, '.factory', 'projects', 'tmp-droid-project', `${id}.jsonl`), rows);
    writeJsonl(path.join(home, '.factory', 'sessions', 'tmp-droid-project', `${id}.jsonl`), rows);

    const { parseDroidSessions } = await loadDroidParser(home);
    const sessions = await parseDroidSessions();

    expect(sessions.filter((session) => session.id === id)).toHaveLength(1);
    expect(sessions[0].originalPath).toContain(path.join('.factory', 'projects'));
  });

  it('uses full transcript timestamps beyond the first 100 lines', async () => {
    const home = makeHome();
    const olderId = '33333333-3333-4333-8333-333333333333';
    const newerId = '44444444-4444-4444-8444-444444444444';
    writeJsonl(
      path.join(home, '.factory', 'projects', 'tmp-droid-project', `${olderId}.jsonl`),
      makeRows({ id: olderId, last: '2026-04-15T10:05:00.000Z' }),
    );
    writeJsonl(
      path.join(home, '.factory', 'projects', 'tmp-droid-project', `${newerId}.jsonl`),
      makeRows({ id: newerId, fillerCount: 120, last: '2026-04-15T11:30:00.000Z' }),
    );

    const { parseDroidSessions } = await loadDroidParser(home);
    const sessions = await parseDroidSessions();

    expect(sessions[0].id).toBe(newerId);
    expect(sessions[0].updatedAt.toISOString()).toBe('2026-04-15T11:30:00.000Z');
  });

  it('keeps lightweight discovery bounded and preserves sessions with zero line counts', async () => {
    const home = makeHome();
    const id = '55555555-5555-4555-8555-555555555555';
    writeJsonl(
      path.join(home, '.factory', 'projects', 'tmp-droid-project', `${id}.jsonl`),
      makeRows({ id, fillerCount: 120, last: '2026-04-15T11:30:00.000Z' }),
    );

    const { parseDroidSessions } = await loadDroidParser(home);
    const sessions = await parseDroidSessions({ lightweight: true });

    expect(sessions.map((session) => session.id)).toContain(id);
    expect(sessions.find((session) => session.id === id)?.lines).toBe(0);
  });

  it('strips bootstrap reminders from conversation and avoids repo inference when bootstrap proves non-git cwd', async () => {
    const home = makeHome();
    const id = '66666666-6666-4666-8666-666666666666';
    const sessionPath = path.join(home, '.factory', 'projects', 'tmp-droid-project', `${id}.jsonl`);
    writeJsonl(sessionPath, [
      {
        type: 'session_start',
        id,
        title: 'Droid bootstrap regression',
        sessionTitle: 'Droid bootstrap regression',
        cwd: '/tmp/droid-project',
        owner: 'factory',
        version: 42,
      },
      {
        type: 'message',
        id: `${id}-user`,
        timestamp: '2026-04-15T10:00:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>git rev-parse --show-toplevel\nfatal: not a git repository</system-reminder>\nRepair the Droid parser now',
            },
          ],
        },
      },
      {
        type: 'message',
        id: `${id}-assistant`,
        timestamp: '2026-04-15T10:00:01.000Z',
        parentId: `${id}-user`,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Droid parser repaired.' }] },
      },
    ]);

    const { parseDroidSessions, extractDroidContext } = await loadDroidParser(home);
    const [session] = await parseDroidSessions();
    const context = await extractDroidContext(session);

    expect(session.repo).toBeUndefined();
    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Repair the Droid parser now',
      'Droid parser repaired.',
    ]);
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      sessionTitle: 'Droid bootstrap regression',
      owner: 'factory',
      version: 42,
      cwd: '/tmp/droid-project',
    });
    expect(context.sessionNotes?.bootstrap?.[0].content).toContain('fatal: not a git repository');
    expect(context.markdown).not.toContain('<system-reminder>');
  });
});

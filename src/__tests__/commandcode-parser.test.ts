import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tmpDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commandcode-parser-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, rows: unknown[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

async function loadParser(home: string) {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  vi.stubEnv('COMMANDCODE_HOME', path.join(home, '.commandcode'));
  return import('../parsers/commandcode.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('CommandCode parser', () => {
  it('discovers and extracts legacy direct-message transcripts', async () => {
    const home = makeHome();
    const id = '11111111-1111-4111-8111-111111111111';
    const sessionPath = writeJsonl(path.join(home, '.commandcode', 'projects', 'tmp-project', `${id}.jsonl`), [
      {
        id: 'user-1',
        parentId: null,
        sessionId: id,
        role: 'user',
        timestamp: '2026-08-01T10:00:00.000Z',
        content: [{ type: 'text', text: 'Add CommandCode support' }],
      },
      {
        id: 'assistant-1',
        parentId: 'user-1',
        sessionId: id,
        role: 'assistant',
        timestamp: '2026-08-01T10:00:01.000Z',
        content: [
          { type: 'text', text: 'Implementing support.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'write_file',
            input: { path: '/tmp/project/cmd.ts', content: 'export const cmd = true;' },
          },
        ],
      },
      {
        id: 'tool-1',
        parentId: 'assistant-1',
        sessionId: id,
        role: 'tool',
        timestamp: '2026-08-01T10:00:02.000Z',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'write_file',
            output: { type: 'text', value: 'Created /tmp/project/cmd.ts' },
          },
        ],
      },
    ]);
    fs.writeFileSync(sessionPath.replace(/\.jsonl$/u, '.meta.json'), JSON.stringify({ model: 'gpt-5.6' }));
    const { extractCommandCodeContext, parseCommandCodeSessions } = await loadParser(home);

    const [session] = await parseCommandCodeSessions();
    const context = await extractCommandCodeContext(session);

    expect(session).toMatchObject({ id, source: 'cmd', cwd: '/tmp/project', model: 'gpt-5.6' });
    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Add CommandCode support',
      'Implementing support.',
    ]);
    expect(context.filesModified).toEqual(['/tmp/project/cmd.ts']);
  });

  it('supports newer Pi-style CommandCode transcripts', async () => {
    const home = makeHome();
    const id = '22222222-2222-4222-8222-222222222222';
    writeJsonl(path.join(home, '.commandcode', 'projects', 'tmp-project', `${id}.jsonl`), [
      { type: 'session', version: 3, id, cwd: '/tmp/project', timestamp: '2026-08-02T10:00:00.000Z' },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-08-02T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'New format' }] },
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-08-02T10:00:02.000Z',
        message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'text', text: 'Supported.' }] },
      },
    ]);
    const { extractCommandCodeContext, parseCommandCodeSessions } = await loadParser(home);

    const [session] = await parseCommandCodeSessions();
    const context = await extractCommandCodeContext(session);

    expect(session).toMatchObject({ id, cwd: '/tmp/project', model: 'claude-opus' });
    expect(context.recentMessages.map((message) => message.content)).toEqual(['New format', 'Supported.']);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

function makeGeminiHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-parser-'));
  tempDirs.push(dir);
  return dir;
}

async function loadGeminiParser(home: string): Promise<typeof import('../parsers/gemini.js')> {
  vi.resetModules();
  vi.stubEnv('GEMINI_CLI_HOME', home);
  return import('../parsers/gemini.js');
}

function writeGeminiJsonlSession(opts: {
  home: string;
  projectId: string;
  fileName: string;
  records: unknown[];
  projects?: Record<string, string>;
}): string {
  const chatsDir = path.join(opts.home, '.gemini', 'tmp', opts.projectId, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  if (opts.projects) {
    fs.writeFileSync(
      path.join(opts.home, '.gemini', 'projects.json'),
      JSON.stringify({ projects: opts.projects }, null, 2),
      'utf8',
    );
  }
  const filePath = path.join(chatsDir, opts.fileName);
  fs.writeFileSync(filePath, `${opts.records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return filePath;
}

function writeGeminiLegacySession(opts: {
  home: string;
  projectId: string;
  fileName: string;
  session: unknown;
}): string {
  const chatsDir = path.join(opts.home, '.gemini', 'tmp', opts.projectId, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, opts.fileName);
  fs.writeFileSync(filePath, JSON.stringify(opts.session, null, 2), 'utf8');
  return filePath;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('gemini parser hardening', () => {
  it('discovers JSONL chat recordings and recovers cwd from projects.json mapping', async () => {
    const home = makeGeminiHome();
    writeGeminiJsonlSession({
      home,
      projectId: 'proj-short-id',
      fileName: 'session-2026-04-15T10-00-test1234.jsonl',
      projects: { '/tmp/gemini-project': 'proj-short-id' },
      records: [
        {
          sessionId: 'gemini-jsonl-session',
          projectHash: 'proj-short-id',
          startTime: '2026-04-15T10:00:00.000Z',
          lastUpdated: '2026-04-15T10:00:00.000Z',
        },
        {
          id: 'msg-user-1',
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'user',
          content: [{ type: 'text', text: 'Inspect current recorder format' }],
        },
      ],
    });

    const { parseGeminiSessions } = await loadGeminiParser(home);
    const sessions = await parseGeminiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('gemini-jsonl-session');
    expect(sessions[0].cwd).toBe('/tmp/gemini-project');
    expect(sessions[0].summary).toBe('Inspect current recorder format');
  });

  it('replays metadata updates and rewind markers in JSONL sessions', async () => {
    const home = makeGeminiHome();
    const originalPath = writeGeminiJsonlSession({
      home,
      projectId: 'proj-short-id',
      fileName: 'session-2026-04-15T10-00-replay1234.jsonl',
      projects: { '/tmp/gemini-project': 'proj-short-id' },
      records: [
        {
          sessionId: 'gemini-replay-session',
          projectHash: 'proj-short-id',
          startTime: '2026-04-15T10:00:00.000Z',
          lastUpdated: '2026-04-15T10:00:00.000Z',
        },
        {
          id: 'msg-user-1',
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'user',
          content: [{ type: 'text', text: 'Find the auth issue' }],
        },
        {
          id: 'msg-asst-1',
          timestamp: '2026-04-15T10:00:02.000Z',
          type: 'gemini',
          content: '',
          model: 'gemini-2.5-pro',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'read_file',
              args: { file_path: 'login.ts' },
              status: 'completed',
              timestamp: '2026-04-15T10:00:02.000Z',
              resultDisplay: { filePath: 'login.ts', fileName: 'login.ts' },
            },
          ],
          tokens: { input: 50, output: 10, cached: 3, thoughts: 2, total: 65 },
        },
        {
          id: 'msg-asst-2',
          timestamp: '2026-04-15T10:00:03.000Z',
          type: 'gemini',
          content: 'Interim answer that should be rewound away',
        },
        { $rewindTo: 'msg-asst-2' },
        {
          id: 'msg-asst-1',
          timestamp: '2026-04-15T10:00:04.000Z',
          type: 'gemini',
          content: 'Final answer after replay',
          model: 'gemini-2.5-pro',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'read_file',
              args: { file_path: 'login.ts' },
              status: 'completed',
              timestamp: '2026-04-15T10:00:04.000Z',
              resultDisplay: { filePath: 'login.ts', fileName: 'login.ts' },
            },
          ],
          thoughts: [{ subject: 'Next step', description: 'Patch login.ts' }],
          tokens: { input: 70, output: 20, cached: 5, thoughts: 4, total: 99 },
        },
        {
          $set: {
            lastUpdated: '2026-04-15T10:00:05.000Z',
            summary: 'Replayed summary',
            directories: ['/tmp/gemini-project', '/tmp/extra-dir'],
          },
        },
      ],
    });

    const { extractGeminiContext } = await loadGeminiParser(home);
    const session: UnifiedSession = {
      id: 'gemini-replay-session',
      source: 'gemini',
      cwd: '/tmp/gemini-project',
      repo: '',
      lines: 7,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T10:00:05.000Z'),
      originalPath,
      summary: 'Find the auth issue',
    };

    const context = await extractGeminiContext(session);

    expect(context.recentMessages.map((message) => message.content)).toContain('Final answer after replay');
    expect(context.recentMessages.map((message) => message.content)).not.toContain(
      'Interim answer that should be rewound away',
    );
    expect(context.filesModified).toContain('login.ts');
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 120, output: 30 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 0, read: 8 });
    expect(context.sessionNotes?.thinkingTokens).toBe(6);
    expect(context.sessionNotes?.model).toBe('gemini-2.5-pro');
  });

  it('falls back to legacy JSON session blobs in chats directories', async () => {
    const home = makeGeminiHome();
    writeGeminiLegacySession({
      home,
      projectId: 'legacy-proj-id',
      fileName: 'session-2026-04-15T10-00-legacy1234.json',
      session: {
        sessionId: 'gemini-legacy-session',
        projectHash: 'legacy-proj-id',
        startTime: '2026-04-15T11:00:00.000Z',
        lastUpdated: '2026-04-15T11:02:00.000Z',
        messages: [
          {
            id: 'legacy-user-1',
            timestamp: '2026-04-15T11:00:01.000Z',
            type: 'user',
            content: [{ type: 'text', text: 'Handle the fallback path' }],
          },
          {
            id: 'legacy-asst-1',
            timestamp: '2026-04-15T11:00:02.000Z',
            type: 'gemini',
            content: 'Legacy response',
          },
        ],
      },
    });

    const { parseGeminiSessions } = await loadGeminiParser(home);
    const sessions = await parseGeminiSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('gemini-legacy-session');
    expect(sessions[0].summary).toBe('Handle the fallback path');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

function makeCursorHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-parser-'));
  tempDirs.push(dir);
  return dir;
}

function writeCursorTranscript(
  home: string,
  slug: string,
  sessionId: string,
  rows: unknown[],
  fileName = `${sessionId}.jsonl`,
): string {
  const dir = path.join(home, '.cursor', 'projects', slug, 'agent-transcripts', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

function writeFlatCursorTranscript(home: string, slug: string, sessionId: string, rows: unknown[]): string {
  const dir = path.join(home, '.cursor', 'projects', slug, 'agent-transcripts');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

function writeCursorRepoJson(home: string, slug: string, data: unknown): void {
  const dir = path.join(home, '.cursor', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify(data), 'utf8');
}

function cursorTextRow(role: 'user' | 'assistant', text: string, timestamp: string): unknown {
  return {
    role,
    timestamp,
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

async function loadCursorParser(home: string): Promise<typeof import('../parsers/cursor.js')> {
  vi.resetModules();
  vi.doMock('../utils/parser-helpers.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/parser-helpers.js')>();
    return {
      ...actual,
      homeDir: () => home,
    };
  });
  return import('../parsers/cursor.js');
}

afterEach(() => {
  vi.doUnmock('../utils/parser-helpers.js');
  vi.resetModules();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('cursor parser confidence warnings', () => {
  it('records transcript completeness as a fidelity warning without fabricating tool results', async () => {
    const home = makeCursorHome();
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const originalPath = writeCursorTranscript(home, 'Users-test-project', sessionId, [
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: 'Review auth flow' }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [{ type: 'text', text: 'I checked the transcript.' }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_shell', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      },
    ]);

    const { extractCursorContext } = await loadCursorParser(home);
    const context = await extractCursorContext({
      id: sessionId,
      source: 'cursor',
      cwd: '/Users/test/project',
      repo: 'test/project',
      lines: 2,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T00:00:00.000Z'),
      updatedAt: new Date('2026-04-15T00:00:00.000Z'),
      originalPath,
      summary: 'Review auth flow',
    } satisfies UnifiedSession);

    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Cursor transcript completeness warning')]),
    );
    expect(context.sessionNotes?.reasoning).toBeUndefined();
    expect(context.markdown).toContain('## Source Fidelity');
    expect(context.markdown).toContain('Cursor transcript completeness warning');

    const bashSummary = context.toolSummaries.find((summary) => summary.name === 'Bash');
    expect(bashSummary?.samples[0]?.summary).toBe('$ pnpm test');
    const bashData = bashSummary?.samples[0]?.data;
    expect(bashData?.category).toBe('shell');
    if (bashData?.category === 'shell') {
      expect(bashData.exitCode).toBeUndefined();
      expect(bashData.stdoutTail).toBeUndefined();
      expect(bashData.errorMessage).toBeUndefined();
    }
  });
});

describe('cursor parser hardening', () => {
  it('discovers nested transcript.jsonl and flat Cursor CLI transcript layouts', async () => {
    const home = makeCursorHome();
    const nestedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const flatId = 'ffffffff-1111-2222-3333-444444444444';
    writeCursorRepoJson(home, 'Users-test-project', { workspace: '/tmp/cursor-project' });
    writeCursorTranscript(
      home,
      'Users-test-project',
      nestedId,
      [
        {
          role: 'user',
          message: {
            content: [{ type: 'text', text: 'Nested transcript keeps parent id' }],
          },
        },
      ],
      'transcript.jsonl',
    );
    writeFlatCursorTranscript(home, 'Users-test-project', flatId, [
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: 'Flat transcript should also be discovered' }],
        },
      },
    ]);

    const { parseCursorSessions } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();

    expect(sessions.map((session) => session.id)).toEqual(expect.arrayContaining([nestedId, flatId]));
    expect(sessions.find((session) => session.id === nestedId)?.cwd).toBe('/tmp/cursor-project');
    expect(sessions.find((session) => session.id === nestedId)?.summary).toBe('Nested transcript keeps parent id');
    expect(sessions.find((session) => session.id === flatId)?.summary).toBe(
      'Flat transcript should also be discovered',
    );
  });

  it('orders long transcripts by filesystem recency instead of head-scan timestamps', async () => {
    const home = makeCursorHome();
    const olderId = '22222222-3333-4444-5555-666666666666';
    const newerId = '33333333-4444-5555-6666-777777777777';
    const olderPath = writeCursorTranscript(home, 'Users-test-project', olderId, [
      cursorTextRow('user', 'Short transcript', '2026-04-15T11:00:00.000Z'),
    ]);
    const newerRows = Array.from({ length: 100 }, (_, index) =>
      cursorTextRow(
        index === 0 ? 'user' : 'assistant',
        index === 0 ? 'Long transcript starts old' : `Filler response ${index}`,
        new Date(Date.UTC(2026, 3, 15, 10, 0, index)).toISOString(),
      ),
    );
    newerRows.push(cursorTextRow('assistant', 'Tail response after head scan', '2026-04-15T11:30:00.000Z'));
    const newerPath = writeCursorTranscript(home, 'Users-test-project', newerId, newerRows);

    fs.utimesSync(olderPath, new Date('2026-04-15T11:00:00.000Z'), new Date('2026-04-15T11:00:00.000Z'));
    fs.utimesSync(newerPath, new Date('2026-04-15T11:30:00.000Z'), new Date('2026-04-15T11:30:00.000Z'));

    const { parseCursorSessions } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();

    expect(sessions[0].id).toBe(newerId);
    expect(sessions[0].updatedAt.toISOString()).toBe('2026-04-15T11:30:00.000Z');
    expect(sessions[1].id).toBe(olderId);
  });

  it('extracts context from string content, user_query wrappers, tools, and malformed records without throwing', async () => {
    const home = makeCursorHome();
    const sessionId = '99999999-8888-7777-6666-555555555555';
    const originalPath = writeCursorTranscript(home, 'Users-test-project', sessionId, [
      {
        role: 'system',
        message: {
          content: [{ type: 'text', text: 'hidden prompt' }],
        },
      },
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Apr 26, 2026, 9:53 PM (UTC-4)</timestamp>\n<user_query>\nFix auth\n</user_query>',
            },
          ],
        },
      },
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: '<system_reminder>not human text</system_reminder>' }],
        },
      },
      {
        role: 'assistant',
        model: 'claude-sonnet-4',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
        message: {
          content: [
            { type: 'text', text: 'I will inspect the file.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Edit',
              input: {
                file_path: 'src/auth.ts',
                old_string: 'bad',
                new_string: 'good',
              },
            },
          ],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_shell', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: 'String content should become assistant text',
        },
      },
      {
        role: 'assistant',
        message: {},
      },
    ]);
    fs.appendFileSync(originalPath, '{"broken":\n', 'utf8');

    const { extractCursorContext, parseCursorSessions } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();
    const context = await extractCursorContext({
      id: sessionId,
      source: 'cursor',
      cwd: '/Users/test/project',
      repo: 'test/project',
      lines: fs.readFileSync(originalPath, 'utf8').split('\n').length - 1,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T00:00:00.000Z'),
      updatedAt: new Date('2026-04-15T00:00:00.000Z'),
      originalPath,
      summary: 'Fix auth',
    } satisfies UnifiedSession);

    expect(sessions.find((session) => session.id === sessionId)?.summary).toBe('Fix auth');
    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Fix auth',
      'I will inspect the file.',
      'String content should become assistant text',
    ]);
    expect(context.recentMessages[0].timestamp?.toISOString()).toBe('2026-04-27T01:53:00.000Z');
    expect(context.filesModified).toContain('src/auth.ts');
    expect(context.sessionNotes?.model).toBe('claude-sonnet-4');
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 10, output: 5 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 2, read: 3 });
    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Cursor transcript completeness warning')]),
    );
    expect(context.sessionNotes?.reasoning).toBeUndefined();
    expect(context.toolSummaries.find((summary) => summary.name === 'Bash')?.samples[0]?.summary).toBe('$ pnpm test');
    expect(context.markdown).not.toContain('system_reminder');
    expect(context.markdown).toContain('local agent-transcripts are partial exports');
  });

  it('keeps long transcripts whose first parseable record sits past the head scan window', async () => {
    const home = makeCursorHome();
    const sessionId = '44444444-5555-6666-7777-888888888888';

    const rows: unknown[] = [];
    // 120 prefix records that the normalizer rejects (no role / no content) —
    // before the gate fix, these would zero out messageCount and drop the
    // session even though the full-file parse below recovers real messages.
    for (let i = 0; i < 120; i++) {
      rows.push({ event: 'noise', i });
    }
    rows.push({
      role: 'user',
      message: { content: [{ type: 'text', text: 'Real user message after head scan' }] },
    });
    rows.push({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'Real assistant reply' }] },
    });

    const originalPath = writeCursorTranscript(home, 'Users-test-project', sessionId, rows);

    const { parseCursorSessions, extractCursorContext } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();
    const session = sessions.find((s) => s.id === sessionId);

    expect(session, 'session past head-scan window must still be discovered').toBeDefined();

    const context = await extractCursorContext({
      ...(session as UnifiedSession),
      originalPath,
    });
    expect(context.recentMessages.map((m) => m.content)).toEqual([
      'Real user message after head scan',
      'Real assistant reply',
    ]);
  });

  it('strips every <timestamp> tag, not just the first occurrence', async () => {
    const home = makeCursorHome();
    const sessionId = '55555555-6666-7777-8888-999999999999';
    writeCursorTranscript(home, 'Users-test-project', sessionId, [
      {
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Apr 26, 2026, 9:53 PM (UTC-4)</timestamp>\n<user_query>\nFirst question\n</user_query>',
            },
          ],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Apr 26, 2026, 9:54 PM (UTC-4)</timestamp> some answer <timestamp>Sunday, Apr 26, 2026, 9:55 PM (UTC-4)</timestamp> more answer',
            },
          ],
        },
      },
    ]);

    const { extractCursorContext, parseCursorSessions } = await loadCursorParser(home);
    const [session] = await parseCursorSessions();
    const context = await extractCursorContext(session);

    const assistantMessage = context.recentMessages.find((m) => m.role === 'assistant');
    expect(assistantMessage?.content).not.toContain('<timestamp>');
    expect(assistantMessage?.content).not.toContain('</timestamp>');
    expect(assistantMessage?.content).toContain('some answer');
    expect(assistantMessage?.content).toContain('more answer');
  });

  it('deduplicates sessions when both <uuid>/transcript.jsonl and <uuid>.jsonl exist for the same id', async () => {
    const home = makeCursorHome();
    const sharedId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
    const slug = 'Users-test-project';

    // Nested transcript.jsonl
    const nestedDir = path.join(home, '.cursor', 'projects', slug, 'agent-transcripts', sharedId);
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedPath = path.join(nestedDir, 'transcript.jsonl');
    fs.writeFileSync(
      nestedPath,
      `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'older copy' }] } })}\n`,
      'utf8',
    );

    // Sibling <uuid>/<uuid>.jsonl in the same dir (legacy lingering file)
    const siblingPath = path.join(nestedDir, `${sharedId}.jsonl`);
    fs.writeFileSync(
      siblingPath,
      `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'newer copy' }] } })}\n`,
      'utf8',
    );

    fs.utimesSync(nestedPath, new Date('2026-04-15T10:00:00.000Z'), new Date('2026-04-15T10:00:00.000Z'));
    fs.utimesSync(siblingPath, new Date('2026-04-15T11:00:00.000Z'), new Date('2026-04-15T11:00:00.000Z'));

    const { parseCursorSessions } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();
    const matching = sessions.filter((s) => s.id === sharedId);

    expect(matching).toHaveLength(1);
    expect(matching[0].updatedAt.toISOString()).toBe('2026-04-15T11:00:00.000Z');
  });

  it('honors repo.json key precedence: workspace > rootPath > path', async () => {
    const home = makeCursorHome();

    // Slug A: workspace wins over rootPath and path
    writeCursorRepoJson(home, 'Users-test-projectA', {
      workspace: '/tmp/cursor-projectA-workspace',
      rootPath: '/tmp/cursor-projectA-rootpath',
      path: '/tmp/cursor-projectA-path',
    });
    writeCursorTranscript(home, 'Users-test-projectA', 'aaaaaaaa-1111-2222-3333-444444444444', [
      { role: 'user', message: { content: [{ type: 'text', text: 'project A' }] } },
    ]);

    // Slug B: rootPath wins over path when workspace is absent
    writeCursorRepoJson(home, 'Users-test-projectB', {
      rootPath: '/tmp/cursor-projectB-rootpath',
      path: '/tmp/cursor-projectB-path',
    });
    writeCursorTranscript(home, 'Users-test-projectB', 'bbbbbbbb-1111-2222-3333-444444444444', [
      { role: 'user', message: { content: [{ type: 'text', text: 'project B' }] } },
    ]);

    // Slug C: path is the last resort
    writeCursorRepoJson(home, 'Users-test-projectC', {
      path: '/tmp/cursor-projectC-path',
    });
    writeCursorTranscript(home, 'Users-test-projectC', 'cccccccc-1111-2222-3333-444444444444', [
      { role: 'user', message: { content: [{ type: 'text', text: 'project C' }] } },
    ]);

    // Slug D: empty values fall through to next key
    writeCursorRepoJson(home, 'Users-test-projectD', {
      workspace: '',
      rootPath: '/tmp/cursor-projectD-rootpath',
      path: '/tmp/cursor-projectD-path',
    });
    writeCursorTranscript(home, 'Users-test-projectD', 'dddddddd-1111-2222-3333-444444444444', [
      { role: 'user', message: { content: [{ type: 'text', text: 'project D' }] } },
    ]);

    const { parseCursorSessions } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();
    const byId = new Map(sessions.map((s) => [s.id, s.cwd]));

    expect(byId.get('aaaaaaaa-1111-2222-3333-444444444444')).toBe('/tmp/cursor-projectA-workspace');
    expect(byId.get('bbbbbbbb-1111-2222-3333-444444444444')).toBe('/tmp/cursor-projectB-rootpath');
    expect(byId.get('cccccccc-1111-2222-3333-444444444444')).toBe('/tmp/cursor-projectC-path');
    expect(byId.get('dddddddd-1111-2222-3333-444444444444')).toBe('/tmp/cursor-projectD-rootpath');
  });

  it('discovers Cursor sub-agent transcripts under <sid>/subagents/', async () => {
    // Per Cursor's documented agent-transcripts layout (observed in
    // dev.to reverse-engineering article + VibeLens parser), sub-agent
    // sessions live at:
    //   ~/.cursor/projects/<slug>/agent-transcripts/<parent-sid>/subagents/<child-sid>.jsonl
    // findFiles' maxDepth=2 lets us reach them; getSessionId returns the
    // child uuid (parent dir is `subagents`, which is excluded only when the
    // stem is the literal `transcript` — child stems are uuids, so they pass).
    const home = makeCursorHome();
    const parentSid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const childSid = 'bbbbbbbb-1111-2222-3333-444444444444';

    writeCursorRepoJson(home, 'Users-test-project', { workspace: '/tmp/cursor-project' });
    writeCursorTranscript(
      home,
      'Users-test-project',
      parentSid,
      [{ role: 'user', message: { content: [{ type: 'text', text: 'parent transcript' }] } }],
      'transcript.jsonl',
    );

    const subDir = path.join(
      home,
      '.cursor',
      'projects',
      'Users-test-project',
      'agent-transcripts',
      parentSid,
      'subagents',
    );
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, `${childSid}.jsonl`),
      `${JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'sub-agent prompt' }] },
      })}\n`,
      'utf8',
    );

    const { parseCursorSessions } = await loadCursorParser(home);
    const sessions = await parseCursorSessions();
    const ids = sessions.map((s) => s.id);

    expect(ids).toEqual(expect.arrayContaining([parentSid, childSid]));
    const subagent = sessions.find((s) => s.id === childSid);
    expect(subagent?.cwd).toBe('/tmp/cursor-project');
    expect(subagent?.summary).toBe('sub-agent prompt');
  });
});

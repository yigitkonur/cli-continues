import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractGrokContext, parseGrokSessions } from '../parsers/grok.js';
import { adapters } from '../parsers/registry.js';
import type { UnifiedSession } from '../types/index.js';
import { createGrokFixture } from './fixtures/index.js';

const originalGrokHome = process.env.GROK_HOME;
const tempDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-parser-'));
  tempDirs.push(dir);
  process.env.GROK_HOME = dir;
  return dir;
}

function writeSession(
  home: string,
  group: string,
  sessionId: string,
  summary: Record<string, unknown>,
  updates?: string,
): string {
  const sessionDir = path.join(home, 'sessions', group, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify(summary));
  if (updates !== undefined) fs.writeFileSync(path.join(sessionDir, 'updates.jsonl'), updates);
  return sessionDir;
}

afterEach(() => {
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('grok parser', () => {
  it('reads summary metadata from the URL-encoded cwd group and skips a broken summary', async () => {
    const fixture = createGrokFixture();
    tempDirs.push(fixture.root);
    process.env.GROK_HOME = fixture.root;

    const brokenDir = path.join(fixture.root, 'sessions', encodeURIComponent('/home/user/project'), 'broken-session');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'summary.json'), '{"info":');

    const sessions = await parseGrokSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'test-grok-session-1',
      source: 'grok',
      cwd: '/home/user/project',
      repo: 'user/project',
      branch: 'main',
      gitSha: 'abc123def456',
      summary: 'Fix auth bug',
      lines: 4,
      model: 'grok-4.7',
    });
    expect(sessions[0]?.createdAt.toISOString()).toBe('2026-01-15T10:00:01.000Z');
    expect(sessions[0]?.updatedAt.toISOString()).toBe('2026-01-15T10:05:00.000Z');
    expect(sessions[0]?.bytes).toBeGreaterThan(0);
  });

  it('resolves hashed group directories from .cwd, filters by cwd, and honors limit', async () => {
    const home = makeHome();
    const encoded = encodeURIComponent('/home/user/project');
    writeSession(home, encoded, 'older-session', {
      info: { id: 'older-session', cwd: '/home/user/project' },
      generated_title: 'Older project session',
      created_at: '2026-01-15T09:00:00.000Z',
      updated_at: '2026-01-15T09:00:00.000Z',
      num_chat_messages: 2,
      current_model_id: 'grok-4.7',
    });

    const hashed = path.join(home, 'sessions', 'grok-cwd-deadbeef');
    fs.mkdirSync(hashed, { recursive: true });
    fs.writeFileSync(path.join(hashed, '.cwd'), '/srv/app\n');
    writeSession(home, 'grok-cwd-deadbeef', 'newer-session', {
      info: { id: 'newer-session' },
      generated_title: 'Server session',
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-02-02T00:00:00.000Z',
      num_chat_messages: 3,
    });

    const all = await parseGrokSessions();
    expect(all.map((session) => session.id)).toEqual(['newer-session', 'older-session']);
    expect(all[0]).toMatchObject({ cwd: '/srv/app', summary: 'Server session', lines: 3 });

    const filtered = await parseGrokSessions({ cwd: '/home/user/project' });
    expect(filtered.map((session) => session.id)).toEqual(['older-session']);

    const limited = await parseGrokSessions({ limit: 1 });
    expect(limited.map((session) => session.id)).toEqual(['newer-session']);
  });

  it('uses GROK_HOME and returns nothing for an empty home', async () => {
    const home = makeHome();
    writeSession(home, encodeURIComponent('/work/repo'), 'sess-1', {
      info: { id: 'sess-1', cwd: '/work/repo' },
      generated_title: 'From GROK_HOME',
      updated_at: '2026-03-01T00:00:00.000Z',
    });

    const found = await parseGrokSessions();
    expect(found).toHaveLength(1);
    expect(found[0]?.summary).toBe('From GROK_HOME');

    process.env.GROK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-empty-'));
    tempDirs.push(process.env.GROK_HOME);
    expect(await parseGrokSessions()).toEqual([]);
  });

  it('extracts conversation, tool activity, pending tasks, and usage from updates.jsonl', async () => {
    const fixture = createGrokFixture();
    tempDirs.push(fixture.root);
    process.env.GROK_HOME = fixture.root;
    const [session] = await parseGrokSessions();
    expect(session).toBeDefined();

    const context = await extractGrokContext(session as UnifiedSession);

    expect(context.recentMessages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Fix the authentication bug in login.ts'],
      ['assistant', 'I found the issue in login.ts. The token validation was missing.'],
      ['user', 'Great, please also add error handling'],
      ['assistant', 'Done. I added try-catch blocks and proper error messages.'],
    ]);
    expect(context.recentMessages[1]?.toolCalls?.map((tool) => tool.name)).toEqual(['read_file', 'search_replace']);
    expect(context.recentMessages[1]?.toolCalls?.[0]?.success).toBe(true);
    expect(context.filesModified).toEqual(['/home/user/project/login.ts']);
    expect(context.pendingTasks).toEqual(['Add error handling']);
    expect(context.toolSummaries.map((summary) => summary.name).sort()).toEqual(['read_file', 'search_replace']);
    expect(context.sessionNotes?.reasoning?.[0]).toContain('inspect login.ts');
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 1200, output: 300 });
    expect(context.sessionNotes?.thinkingTokens).toBe(40);
    expect(context.sessionNotes?.fidelityWarnings?.join('\n')).toContain('malformed line');
    expect(context.markdown).toContain('Grok Build');
    expect(context.markdown).toContain('Fix auth bug');
    expect(context.markdown).toContain('updates.jsonl');
    expect(context.markdown).toContain('**Raw source**: directory at path redacted by parser');
    expect(context.sessionNotes?.rawAccess?.redacted).toBe(true);
  });

  it('omits turns rewound away by target_prompt_index and keeps the live continuation', async () => {
    const home = makeHome();
    const sessionId = 'rewind-1';
    let timestamp = 1_700_000_000;
    const line = (update: Record<string, unknown>, method = 'session/update'): string => {
      timestamp += 1;
      return JSON.stringify({ timestamp, method, params: { sessionId, update } });
    };
    const user = (text: string, promptIndex: number): string =>
      line({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: { promptIndex },
      });
    const assistant = (text: string): string =>
      line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const thought = (text: string): string =>
      line({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
    const edit = (toolCallId: string, filePath: string): string =>
      [
        line({
          sessionUpdate: 'tool_call',
          toolCallId,
          rawInput: JSON.stringify({ file_path: filePath, old_string: 'a', new_string: 'b' }),
          _meta: { 'x.ai/tool': { name: 'search_replace' } },
        }),
        line({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' }),
      ].join('\n');

    const updates = [
      user('Keep the login fix', 0),
      thought('Inspect the login form before editing.'),
      assistant('Kept the login fix.'),
      line({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-read',
        rawInput: JSON.stringify({ target_file: '/home/user/project/login.ts' }),
        _meta: { 'x.ai/tool': { name: 'read_file' } },
      }),
      line({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-read', status: 'completed' }),
      line({
        sessionUpdate: 'plan',
        entries: [{ content: 'Keep login tests', status: 'pending' }],
      }),
      user('Superseded: rewrite the database', 1),
      thought('Superseded secret plan for the database.'),
      assistant('Discarded the database rewrite.'),
      edit('tc-discarded', '/home/user/project/discarded-db.ts'),
      line({
        sessionUpdate: 'plan',
        entries: [{ content: 'Ship the superseded rewrite', status: 'pending' }],
      }),
      line(
        { sessionUpdate: 'rewind_marker', target_prompt_index: 6, created_at: '2026-08-24T08:37:12.000Z' },
        '_x.ai/session/update',
      ),
      line(
        { sessionUpdate: 'rewind_marker', target_prompt_index: 1, created_at: '2026-08-24T08:38:08.000Z' },
        '_x.ai/session/update',
      ),
      user('Add a logout button', 1),
      assistant('Added the logout button.'),
      edit('tc-logout', '/home/user/project/logout.ts'),
    ].join('\n');

    writeSession(
      home,
      encodeURIComponent('/home/user/project'),
      sessionId,
      {
        info: { id: sessionId, cwd: '/home/user/project' },
        generated_title: 'Rewind login work',
        updated_at: '2026-08-24T08:40:00.000Z',
      },
      `${updates}\n`,
    );

    const [session] = await parseGrokSessions();
    const context = await extractGrokContext(session as UnifiedSession);
    const transcript = context.recentMessages.map((message) => message.content).join('\n');

    expect(context.recentMessages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Keep the login fix'],
      ['assistant', 'Kept the login fix.'],
      ['user', 'Add a logout button'],
      ['assistant', 'Added the logout button.'],
    ]);
    expect(transcript).not.toContain('Discarded the database rewrite.');
    expect(transcript).not.toContain('Superseded: rewrite the database');
    expect(context.markdown).not.toContain('Discarded the database rewrite.');
    expect(context.markdown).not.toContain('Ship the superseded rewrite');
    expect(context.filesModified).toEqual(['/home/user/project/logout.ts']);
    expect(context.toolSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'read_file', count: 1 }),
        expect.objectContaining({ name: 'search_replace', count: 1 }),
      ]),
    );
    expect(context.toolSummaries).toHaveLength(2);
    expect(context.pendingTasks).toEqual(['Keep login tests']);
    expect(context.sessionNotes?.reasoning?.join('\n')).toContain('Inspect the login form');
    expect(context.sessionNotes?.reasoning?.join('\n')).not.toContain('Superseded secret plan');
  });

  it('applies a later rewind over turns that replaced an earlier one', async () => {
    const home = makeHome();
    const sessionId = 'rewind-2';
    let timestamp = 1_700_000_100;
    const line = (update: Record<string, unknown>): string => {
      timestamp += 1;
      return JSON.stringify({
        timestamp,
        method: update.sessionUpdate === 'rewind_marker' ? '_x.ai/session/update' : 'session/update',
        params: { sessionId, update },
      });
    };
    const user = (text: string, promptIndex: number): string =>
      line({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text },
        _meta: { promptIndex },
      });
    const assistant = (text: string): string =>
      line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

    const updates = [
      user('Original prompt', 0),
      assistant('Original reply'),
      line({ sessionUpdate: 'rewind_marker', target_prompt_index: 0 }),
      user('Replacement prompt', 0),
      assistant('Replacement reply that should also go'),
      line({ sessionUpdate: 'rewind_marker', target_prompt_index: 0 }),
      user('Final prompt', 0),
      assistant('Final reply'),
    ].join('\n');

    writeSession(
      home,
      encodeURIComponent('/home/user/project'),
      sessionId,
      {
        info: { id: sessionId, cwd: '/home/user/project' },
        generated_title: 'Rewound twice',
        updated_at: '2026-08-24T09:00:00.000Z',
      },
      `${updates}\n`,
    );

    const [session] = await parseGrokSessions();
    const context = await extractGrokContext(session as UnifiedSession);

    expect(context.recentMessages.map((message) => message.content)).toEqual(['Final prompt', 'Final reply']);
    expect(context.markdown).not.toContain('Original reply');
    expect(context.markdown).not.toContain('Replacement reply that should also go');
  });

  it('falls back to chat_history.jsonl when updates.jsonl is absent', async () => {
    const home = makeHome();
    const sessionDir = writeSession(home, encodeURIComponent('/home/user/project'), 'hist-1', {
      info: { id: 'hist-1', cwd: '/home/user/project' },
      generated_title: 'History fallback',
      updated_at: '2026-04-01T00:00:00.000Z',
      num_chat_messages: 2,
    });
    const history = [
      JSON.stringify({ type: 'system', content: 'system prompt' }),
      JSON.stringify({
        type: 'user',
        synthetic_reason: 'system_reminder',
        content: [{ type: 'text', text: '<system-reminder>skip me</system-reminder>' }],
      }),
      JSON.stringify({
        type: 'user',
        content: [
          { type: 'text', text: '<user_info>noise</user_info>\n<user_query>Please add error handling</user_query>' },
        ],
      }),
      JSON.stringify({
        type: 'assistant',
        content: 'Done. I added try-catch blocks.',
        tool_calls: [{ id: 't1', name: 'read_file', arguments: JSON.stringify({ target_file: 'login.ts' }) }],
      }),
      JSON.stringify({ type: 'tool_result', tool_call_id: 't1', content: 'export function login() {}' }),
    ];
    fs.writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), `${history.join('\n')}\n`);

    const [session] = await parseGrokSessions();
    const context = await extractGrokContext(session as UnifiedSession);

    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Please add error handling',
      'Done. I added try-catch blocks.',
    ]);
    expect(context.toolSummaries.map((summary) => summary.name)).toEqual(['read_file']);
    expect(context.sessionNotes?.fidelityWarnings?.join('\n')).toContain('chat_history.jsonl');
  });

  it('resumes natively with grok --resume and hands off with a positional prompt', () => {
    const session = {
      id: '01a0eca2-2499-7fa3-adf3-dd6b172528c9',
      source: 'grok',
      cwd: '/home/user/project',
      lines: 1,
      bytes: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: '/tmp/grok-session',
    } satisfies UnifiedSession;

    expect(adapters.grok.binaryName).toBe('grok');
    expect(adapters.grok.envVar).toBe('GROK_HOME');
    expect(adapters.grok.label).toBe('Grok Build');
    expect(adapters.grok.nativeResumeArgs(session)).toEqual(['--resume', session.id]);
    expect(adapters.grok.crossToolArgs('continue this work', session.cwd)).toEqual(['continue this work']);
    expect(adapters.grok.resumeCommandDisplay(session)).toBe(`grok --resume ${session.id}`);
  });
});

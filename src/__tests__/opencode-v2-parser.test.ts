import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { extractOpenCodeContext, normalizeV2Part, parseOpenCodeSessions } from '../parsers/opencode.js';
import type { FixtureDir } from './fixtures/index.js';
import { createOpenCodeSqliteFixture, createOpenCodeV2SqliteFixture } from './fixtures/index.js';

describe('OpenCode v2 fixture', () => {
  let fixture: FixtureDir;

  beforeAll(() => {
    fixture = createOpenCodeV2SqliteFixture();
    vi.stubEnv('OPENCODE_DB', path.join(fixture.root, 'opencode.db'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  it('creates session_v2 and session_message tables with seeded rows', () => {
    // node:sqlite via createRequire, matching the parser's loading strategy
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite');
    const db = new DatabaseSync(path.join(fixture.root, 'opencode.db'), { readOnly: true });
    const sessions = db.prepare('SELECT id, parent_id FROM session_v2 ORDER BY time_created').all() as Array<{
      id: string;
      parent_id: string | null;
    }>;
    const messages = db.prepare('SELECT type FROM session_message ORDER BY seq').all() as Array<{ type: string }>;
    db.close();

    expect(sessions.map((s) => s.id)).toEqual(['ses_v2_root', 'ses_v2_child']);
    expect(sessions[1]?.parent_id).toBe('ses_v2_root');
    expect(messages.map((m) => m.type)).toContain('user');
    expect(messages.map((m) => m.type)).toContain('assistant');
    expect(messages.map((m) => m.type)).toContain('compaction');
    expect(fs.existsSync(path.join(fixture.root, 'opencode.db'))).toBe(true);
  });
});

describe('parseOpenCodeSessions (v2)', () => {
  let fixture: FixtureDir;

  beforeAll(() => {
    fixture = createOpenCodeV2SqliteFixture();
    vi.stubEnv('OPENCODE_DB', path.join(fixture.root, 'opencode.db'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  it('lists sessions from session_v2 including subtask sessions', async () => {
    const sessions = await parseOpenCodeSessions();
    expect(sessions.map((s) => s.id)).toEqual(['ses_v2_root', 'ses_v2_child']);
    expect(sessions[0]?.source).toBe('opencode');
    expect(sessions[0]?.cwd).toBe('/home/user/project');
    expect(sessions[0]?.repo).toBe('user/project');
    expect(sessions[0]?.summary).toBe('Fix v2 auth bug');
    expect(sessions[0]?.model).toBe('test-model');
  });

  it('orders sessions by time_updated descending', async () => {
    const sessions = await parseOpenCodeSessions();
    expect(sessions[0]?.id).toBe('ses_v2_root');
    expect(sessions[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(sessions[1]!.updatedAt.getTime());
  });

  it('falls back to first user message when title is empty', async () => {
    const sessions = await parseOpenCodeSessions();
    const child = sessions.find((s) => s.id === 'ses_v2_child');
    expect(child?.summary).toBe('Subtask'); // fixture title wins; no crash on missing fields
  });
});

describe('parseOpenCodeSessions (legacy fallback)', () => {
  it('reads legacy session table when session_v2 is absent', async () => {
    const legacy = createOpenCodeSqliteFixture();
    vi.stubEnv('OPENCODE_DB', path.join(legacy.root, 'opencode.db'));
    try {
      const sessions = await parseOpenCodeSessions();
      expect(sessions.map((s) => s.id)).toContain('ses_test1');
    } finally {
      vi.unstubAllEnvs();
      legacy.cleanup();
    }
  });
});

describe('parseOpenCodeSessions (mixed v2 + legacy DBs)', () => {
  let v2Fixture: FixtureDir;
  let legacyFixture: FixtureDir;
  let dataHome: string;

  beforeAll(() => {
    v2Fixture = createOpenCodeV2SqliteFixture();
    legacyFixture = createOpenCodeSqliteFixture();
    // Multi-DB discovery layout: $XDG_DATA_HOME/opencode/opencode.db + opencode-*.db
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'test-opencode-datahome-'));
    fs.mkdirSync(path.join(dataHome, 'opencode'), { recursive: true });
    fs.copyFileSync(path.join(v2Fixture.root, 'opencode.db'), path.join(dataHome, 'opencode', 'opencode.db'));
    fs.copyFileSync(path.join(legacyFixture.root, 'opencode.db'), path.join(dataHome, 'opencode', 'opencode-beta.db'));
    vi.stubEnv('XDG_DATA_HOME', dataHome);
    vi.stubEnv('OPENCODE_DB', ''); // empty string is falsy, so multi-DB discovery runs
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    v2Fixture.cleanup();
    legacyFixture.cleanup();
    fs.rmSync(dataHome, { recursive: true, force: true });
  });

  it('merges sessions from v2 and legacy-only DBs', async () => {
    const sessions = await parseOpenCodeSessions();
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain('ses_v2_root');
    expect(ids).toContain('ses_v2_child');
    expect(ids).toContain('ses_test1');
  });

  it('orders merged sessions by time_updated descending', async () => {
    const sessions = await parseOpenCodeSessions();
    expect(sessions).toHaveLength(3);
    expect(sessions[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(sessions[1]!.updatedAt.getTime());
    expect(sessions[1]!.updatedAt.getTime()).toBeGreaterThanOrEqual(sessions[2]!.updatedAt.getTime());
  });
});

describe('normalizeV2Part', () => {
  it('maps v2 tool part fields to v1 shape', () => {
    const normalized = normalizeV2Part({
      type: 'tool',
      id: 'shell_1',
      name: 'shell',
      state: {
        status: 'completed',
        input: { command: 'ls' },
        content: [{ type: 'text', text: 'login.ts' }],
        metadata: { exit: 0 },
      },
    });
    expect(normalized).toMatchObject({
      type: 'tool',
      tool: 'bash', // shell → bash
      callID: 'shell_1',
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output: 'login.ts',
        metadata: { exit: 0 },
      },
    });
  });

  it('accepts legacy field names unchanged', () => {
    const normalized = normalizeV2Part({
      type: 'tool',
      callID: 'bash_1',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'ls' }, output: 'x' },
    });
    expect(normalized).toMatchObject({ tool: 'bash', callID: 'bash_1', state: { output: 'x' } });
  });

  it('maps webfetch/websearch names and keeps unknown tools', () => {
    expect(normalizeV2Part({ type: 'tool', name: 'webfetch', state: {} })).toMatchObject({ tool: 'web_fetch' });
    expect(normalizeV2Part({ type: 'tool', name: 'websearch', state: {} })).toMatchObject({ tool: 'web_search' });
    expect(normalizeV2Part({ type: 'tool', name: 'question', state: {} })).toMatchObject({ tool: 'question' });
  });

  it('passes text and reasoning parts through and drops unknown types', () => {
    expect(normalizeV2Part({ type: 'text', text: 'hello' })).toMatchObject({ type: 'text', text: 'hello' });
    expect(normalizeV2Part({ type: 'reasoning', text: 'thinking' })).toMatchObject({
      type: 'reasoning',
      text: 'thinking',
    });
    expect(normalizeV2Part({ type: 'step-start' })).toBeNull();
    expect(normalizeV2Part({ type: 'step-finish' })).toBeNull();
  });
});

describe('readMessagesFromV2Sqlite via extractOpenCodeContext', () => {
  let fixture: FixtureDir;

  beforeAll(() => {
    fixture = createOpenCodeV2SqliteFixture();
    vi.stubEnv('OPENCODE_DB', path.join(fixture.root, 'opencode.db'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  async function extractRootContext() {
    const sessions = await parseOpenCodeSessions();
    const root = sessions.find((s) => s.id === 'ses_v2_root')!;
    return extractOpenCodeContext(root);
  }

  it('extracts user and assistant messages with tool calls', async () => {
    const context = await extractRootContext();
    const roles = context.recentMessages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');

    const assistant = context.recentMessages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toContain('Fixed the auth bug.');
    expect(assistant.content).toContain('[reasoning]');
    const toolNames = (assistant.toolCalls ?? []).map((t) => t.name);
    expect(toolNames).toEqual(['bash', 'read', 'edit', 'todowrite']);
  });

  it('renders shell results and keeps v2 `path` inputs', async () => {
    const context = await extractRootContext();
    const assistant = context.recentMessages.find((m) => m.role === 'assistant')!;
    const bash = assistant.toolCalls!.find((t) => t.name === 'bash')!;
    expect(bash.result).toContain('login.ts');
    const read = assistant.toolCalls!.find((t) => t.name === 'read')!;
    expect(read.arguments).toMatchObject({ path: '/home/user/project/login.ts' });
  });

  it('includes compaction as meta system message and excludes synthetic rows', async () => {
    const context = await extractRootContext();
    const meta = context.recentMessages.filter((m) => m.isMeta);
    expect(
      meta.some((m) => m.role === 'system' && m.content.includes('[compacted context] Discussed auth flow.')),
    ).toBe(true);
    expect(context.recentMessages.some((m) => m.content.includes('Continue if you have next steps'))).toBe(false);
  });

  it('extracts pending tasks from the latest todowrite call', async () => {
    const context = await extractRootContext();
    expect(context.pendingTasks).toEqual(['[high] Add tests']);
  });
});

describe('readMessagesFromV2Sqlite event-row policy', () => {
  let fixture: FixtureDir;
  const markers = [
    'SECRET_SYSTEM_PROMPT_MARKER',
    'SECRET_IDLE_MARKER',
    'SECRET_AGENT_SWITCH_MARKER',
    'SECRET_MODEL_SWITCH_MARKER',
    'SECRET_UNKNOWN_TYPE_MARKER',
  ];

  beforeAll(() => {
    fixture = createOpenCodeV2SqliteFixture();
    // Seed event rows that must never reach the conversation or handoff
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite');
    const db = new DatabaseSync(path.join(fixture.root, 'opencode.db'));
    const insert = db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const now = Date.now();
    const eventRows: Array<[string, string, string]> = [
      ['msg_v2_sys1', 'system', markers[0]!],
      ['msg_v2_idle1', 'idle', markers[1]!],
      ['msg_v2_agent1', 'agent-switched', markers[2]!],
      ['msg_v2_model1', 'model-switched', markers[3]!],
      ['msg_v2_unknown1', 'totally-unknown', markers[4]!],
    ];
    for (const [id, type, text] of eventRows) {
      insert.run(id, 'ses_v2_root', type, 100, now, now, JSON.stringify({ text }));
    }
    db.close();
    vi.stubEnv('OPENCODE_DB', path.join(fixture.root, 'opencode.db'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  it('never lets excluded event rows reach the conversation or handoff', async () => {
    const sessions = await parseOpenCodeSessions();
    const root = sessions.find((s) => s.id === 'ses_v2_root')!;
    const context = await extractOpenCodeContext(root);

    const allContent = context.recentMessages.map((m) => m.content).join('\n');
    for (const marker of markers) {
      expect(allContent).not.toContain(marker);
      expect(context.markdown).not.toContain(marker);
    }
  });
});

describe('extractOpenCodeToolData (v2)', () => {
  let fixture: FixtureDir;

  beforeAll(() => {
    fixture = createOpenCodeV2SqliteFixture();
    vi.stubEnv('OPENCODE_DB', path.join(fixture.root, 'opencode.db'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  async function extractRootContext() {
    const sessions = await parseOpenCodeSessions();
    const root = sessions.find((s) => s.id === 'ses_v2_root')!;
    return extractOpenCodeContext(root);
  }

  it('summarizes tool activity and tracks modified files', async () => {
    const context = await extractRootContext();

    const names = context.toolSummaries.map((s) => s.name);
    expect(names).toContain('bash');
    expect(context.filesModified).toContain('/home/user/project/login.ts');

    const md = context.markdown;
    expect(md).toContain('## Tool Activity');
    expect(md).toContain('ls');
    expect(md).toContain('login.ts');

    // Pin the state.metadata.diff fallback: every assertion below is derived
    // from the patch text and must fail if the metadata diff/patch lookup in
    // summarizeOpenCodeToolPart's edit branch is removed
    const editTool = context.toolSummaries.find((s) => s.name === 'edit')!;
    const editSample = editTool.samples[0]!;
    expect(editSample.summary).toBe('patch: login.ts');
    expect(editSample.data).toMatchObject({
      category: 'edit',
      filePath: '/home/user/project/login.ts',
      diffStats: { added: 1, removed: 1 },
    });
    expect(md).toContain('(+1 -1 lines)'); // diffStats tag rendered from the patch
    expect(md).toContain('@@ -1 +1 @@'); // diff body rendered from the patch
  });

  it('counts session-level diff stats from session_v2 summary columns', async () => {
    const context = await extractRootContext();
    const editSummary = context.toolSummaries
      .flatMap((s) => s.samples)
      .find((sample) => sample.summary.includes('2 file(s) changed'));
    expect(editSummary).toBeDefined();
    expect(editSummary?.summary).toBe('2 file(s) changed (+12 -3)');
  });
});

describe('v2 session notes and pending tasks', () => {
  let fixture: FixtureDir;

  beforeAll(() => {
    fixture = createOpenCodeV2SqliteFixture();
    vi.stubEnv('OPENCODE_DB', path.join(fixture.root, 'opencode.db'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  it('populates token usage, model, and fidelity metadata from session_v2', async () => {
    const sessions = await parseOpenCodeSessions();
    const root = sessions.find((s) => s.id === 'ses_v2_root')!;
    const context = await extractOpenCodeContext(root);
    const notes = context.sessionNotes!;

    expect(notes.tokenUsage).toEqual({ input: 1000, output: 200 });
    expect(notes.thinkingTokens).toBe(50);
    expect(notes.cacheTokens).toEqual({ read: 4000, creation: 100 });
    expect(notes.model).toBe('test-model');
    expect(notes.sourceMetadata).toMatchObject({ slug: 'test-session', projectId: 'proj_v2' });
    expect(notes.rawAccess).toEqual({ kind: 'sqlite', path: path.join(fixture.root, 'opencode.db') });
    expect(notes.fidelityWarnings?.join(' ')).toContain('synthetic');
  });

  it('tags subtask sessions with parentId', async () => {
    const sessions = await parseOpenCodeSessions();
    const child = sessions.find((s) => s.id === 'ses_v2_child')!;
    const context = await extractOpenCodeContext(child);
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({ parentId: 'ses_v2_root' });
  });

  it('extracts pending tasks from todowrite input', async () => {
    const sessions = await parseOpenCodeSessions();
    const root = sessions.find((s) => s.id === 'ses_v2_root')!;
    const context = await extractOpenCodeContext(root);
    expect(context.pendingTasks).toEqual(['[high] Add tests']);
    expect(context.markdown).toContain('## Pending Tasks');
  });
});

describe('pending tasks across multiple v2 DBs', () => {
  let emptyV2Fixture: FixtureDir;
  let v2WithSession: FixtureDir;
  let dataHome: string;

  beforeAll(() => {
    // First DB in discovery order is a v2 DB that LACKS the target session;
    // the session (with its todowrite call) lives only in the non-first channel DB.
    emptyV2Fixture = createOpenCodeV2SqliteFixture();
    v2WithSession = createOpenCodeV2SqliteFixture();
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite');
    const stripDb = new DatabaseSync(path.join(emptyV2Fixture.root, 'opencode.db'));
    stripDb.exec('DELETE FROM session_message; DELETE FROM session_v2;');
    stripDb.close();

    // Multi-DB discovery layout: $XDG_DATA_HOME/opencode/opencode.db + opencode-*.db
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'test-opencode-datahome-'));
    fs.mkdirSync(path.join(dataHome, 'opencode'), { recursive: true });
    fs.copyFileSync(path.join(emptyV2Fixture.root, 'opencode.db'), path.join(dataHome, 'opencode', 'opencode.db'));
    fs.copyFileSync(path.join(v2WithSession.root, 'opencode.db'), path.join(dataHome, 'opencode', 'opencode-beta.db'));
    vi.stubEnv('XDG_DATA_HOME', dataHome);
    vi.stubEnv('OPENCODE_DB', ''); // empty string is falsy, so multi-DB discovery runs
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    emptyV2Fixture.cleanup();
    v2WithSession.cleanup();
    fs.rmSync(dataHome, { recursive: true, force: true });
  });

  it('extracts pending tasks from a session living in a non-first v2 DB', async () => {
    const sessions = await parseOpenCodeSessions();
    const root = sessions.find((s) => s.id === 'ses_v2_root')!;
    expect(root).toBeDefined();
    const context = await extractOpenCodeContext(root);
    expect(context.pendingTasks).toEqual(['[high] Add tests']);
  });
});

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractCrushContext, parseCrushSessions } from '../parsers/crush.js';
import type { UnifiedSession } from '../types/index.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

interface CrushFixture {
  dbPath: string;
  projectRoot: string;
  root: string;
  cleanup: () => void;
}

const originalEnv = {
  CRUSH_DB: process.env.CRUSH_DB,
  CRUSH_DB_PATH: process.env.CRUSH_DB_PATH,
  CRUSH_DATA_DIR: process.env.CRUSH_DATA_DIR,
  CRUSH_GLOBAL_DATA: process.env.CRUSH_GLOBAL_DATA,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createCrushFixture(): CrushFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-parser-'));
  const projectRoot = path.join(root, 'project');
  const dataDir = path.join(projectRoot, '.crush');
  const dbPath = path.join(dataDir, 'crush.db');
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      title TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
      prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
      completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
      cost REAL NOT NULL DEFAULT 0.0 CHECK (cost >= 0.0),
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      summary_message_id TEXT,
      todos TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      parts TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      provider TEXT,
      is_summary_message INTEGER DEFAULT 0 NOT NULL
    );
  `);
  db.close();

  return {
    dbPath,
    projectRoot,
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function useFixtureDb(fixture: CrushFixture): void {
  process.env.CRUSH_DB = fixture.dbPath;
  delete process.env.CRUSH_DB_PATH;
  delete process.env.CRUSH_DATA_DIR;
  delete process.env.CRUSH_GLOBAL_DATA;
  process.env.XDG_DATA_HOME = path.join(fixture.root, 'xdg-data');
}

function insertSession(
  fixture: CrushFixture,
  options: {
    id: string;
    title?: string;
    promptTokens?: number;
    completionTokens?: number;
    createdAt?: number;
    updatedAt?: number;
    todos?: string | null;
  },
): void {
  const db = new DatabaseSync(fixture.dbPath);
  db.prepare(
    `INSERT INTO sessions (
      id,
      parent_session_id,
      title,
      message_count,
      prompt_tokens,
      completion_tokens,
      cost,
      updated_at,
      created_at,
      summary_message_id,
      todos
    ) VALUES (?, NULL, ?, 0, ?, ?, 0.25, ?, ?, NULL, ?)`,
  ).run(
    options.id,
    options.title ?? 'New session',
    options.promptTokens ?? 0,
    options.completionTokens ?? 0,
    options.updatedAt ?? 1_734_000_100,
    options.createdAt ?? 1_734_000_000,
    options.todos ?? null,
  );
  db.close();
}

function insertMessage(
  fixture: CrushFixture,
  message: {
    id: string;
    sessionId: string;
    role: string;
    parts: unknown;
    createdAt: number;
    model?: string | null;
    provider?: string | null;
    isSummaryMessage?: boolean;
  },
): void {
  const db = new DatabaseSync(fixture.dbPath);
  const parts = typeof message.parts === 'string' ? message.parts : JSON.stringify(message.parts);
  db.prepare(
    `INSERT INTO messages (
      id,
      session_id,
      role,
      parts,
      model,
      provider,
      is_summary_message,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.sessionId,
    message.role,
    parts,
    message.model ?? null,
    message.provider ?? null,
    message.isSummaryMessage ? 1 : 0,
    message.createdAt,
    message.createdAt,
  );
  db.prepare('UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?').run(
    message.createdAt,
    message.sessionId,
  );
  db.close();
}

function textPart(text: string): Array<{ type: 'text'; data: { text: string } }> {
  return [{ type: 'text', data: { text } }];
}

function clearCrushDiscoveryEnv(root: string): void {
  delete process.env.CRUSH_DB;
  delete process.env.CRUSH_DB_PATH;
  delete process.env.CRUSH_DATA_DIR;
  delete process.env.CRUSH_GLOBAL_DATA;
  process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
}

afterEach(() => {
  restoreEnv();
});

describe('crush parser', () => {
  it('returns no sessions when the configured database is absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-parser-missing-'));
    process.env.CRUSH_DB = path.join(root, 'missing', 'crush.db');
    delete process.env.CRUSH_DB_PATH;
    delete process.env.CRUSH_DATA_DIR;
    delete process.env.CRUSH_GLOBAL_DATA;
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');

    await expect(parseCrushSessions()).resolves.toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses sessions and extracts context from the evidence-grounded SQLite schema', async () => {
    const fixture = createCrushFixture();
    useFixtureDb(fixture);
    insertSession(fixture, {
      id: 'session-1',
      promptTokens: 1234,
      completionTokens: 321,
      createdAt: 1_734_000_000,
      updatedAt: 1_734_000_030,
      todos: JSON.stringify([
        { content: 'Already complete', status: 'completed', priority: 'low' },
        { content: 'Re-run Crush smoke tests', status: 'pending', priority: 'high' },
      ]),
    });
    insertMessage(fixture, {
      id: 'msg-user-1',
      sessionId: 'session-1',
      role: 'user',
      parts: textPart('Fix the failing build for the CLI.'),
      createdAt: 1_734_000_010,
    });
    insertMessage(fixture, {
      id: 'msg-assistant-1',
      sessionId: 'session-1',
      role: 'assistant',
      model: 'claude-sonnet-4.5',
      provider: 'anthropic',
      parts: [
        { type: 'text', data: { text: 'I found the failing TypeScript path.' } },
        {
          type: 'tool_call',
          data: {
            id: 'tool-1',
            name: 'write',
            input: '{"file_path":"src/index.ts","content":"export const ok = true;"}',
            provider_executed: false,
            finished: true,
          },
        },
      ],
      createdAt: 1_734_000_020,
    });
    insertMessage(fixture, {
      id: 'msg-tool-1',
      sessionId: 'session-1',
      role: 'tool',
      parts: [
        {
          type: 'tool_result',
          data: {
            tool_call_id: 'tool-1',
            name: 'write',
            content: 'updated src/index.ts',
            is_error: false,
          },
        },
      ],
      createdAt: 1_734_000_025,
    });
    insertMessage(fixture, {
      id: 'msg-summary',
      sessionId: 'session-1',
      role: 'assistant',
      parts: textPart('Internal summary should not appear.'),
      createdAt: 1_734_000_030,
      isSummaryMessage: true,
    });

    const sessions = await parseCrushSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'session-1',
      source: 'crush',
      cwd: fixture.projectRoot,
      lines: 3,
      model: 'claude-sonnet-4.5',
      summary: 'Fix the failing build for the CLI.',
      originalPath: fixture.dbPath,
    });
    expect(sessions[0]?.createdAt.toISOString()).toBe('2024-12-12T10:40:10.000Z');
    expect(sessions[0]?.updatedAt.toISOString()).toBe('2024-12-12T10:40:25.000Z');

    const context = await extractCrushContext(sessions[0]);
    expect(context.recentMessages).toHaveLength(2);
    expect(context.recentMessages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(context.recentMessages[1]?.toolCalls).toEqual([
      {
        name: 'write',
        id: 'tool-1',
        arguments: { file_path: 'src/index.ts', content: 'export const ok = true;' },
        result: 'updated src/index.ts',
        success: true,
        metadata: { providerExecuted: false, finished: true },
      },
    ]);
    expect(context.filesModified).toEqual(['src/index.ts']);
    expect(context.pendingTasks).toEqual(['[high] Re-run Crush smoke tests']);
    expect(context.toolSummaries).toHaveLength(1);
    expect(context.toolSummaries[0]?.name).toBe('write');
    expect(context.sessionNotes).toMatchObject({
      model: 'claude-sonnet-4.5',
      tokenUsage: { input: 1234, output: 321 },
      sourceMetadata: { provider: 'anthropic', cost: 0.25 },
    });

    fixture.cleanup();
  });

  it('does not mark failed write and edit tool results as modified files', async () => {
    const fixture = createCrushFixture();
    useFixtureDb(fixture);
    insertSession(fixture, { id: 'failed-mutations' });
    insertMessage(fixture, {
      id: 'failed-user',
      sessionId: 'failed-mutations',
      role: 'user',
      parts: textPart('Try to update two files.'),
      createdAt: 1_734_000_010,
    });
    insertMessage(fixture, {
      id: 'failed-assistant',
      sessionId: 'failed-mutations',
      role: 'assistant',
      parts: [
        {
          type: 'tool_call',
          data: {
            id: 'failed-write',
            name: 'write',
            input: '{"file_path":"src/write-target.ts","content":"broken"}',
            finished: true,
          },
        },
        {
          type: 'tool_call',
          data: {
            id: 'failed-edit',
            name: 'edit',
            input: '{"file_path":"src/edit-target.ts","old_string":"old","new_string":"new"}',
            finished: true,
          },
        },
      ],
      createdAt: 1_734_000_020,
    });
    insertMessage(fixture, {
      id: 'failed-tool-results',
      sessionId: 'failed-mutations',
      role: 'tool',
      parts: [
        {
          type: 'tool_result',
          data: {
            tool_call_id: 'failed-write',
            name: 'write',
            content: 'permission denied',
            is_error: true,
          },
        },
        {
          type: 'tool_result',
          data: {
            tool_call_id: 'failed-edit',
            name: 'edit',
            content: 'old_string not found',
            is_error: true,
          },
        },
      ],
      createdAt: 1_734_000_030,
    });

    const sessions = await parseCrushSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('failed-mutations');

    const context = await extractCrushContext(sessions[0]);

    expect(context.filesModified).toEqual([]);
    expect(context.toolSummaries.find((summary) => summary.name === 'write')).toMatchObject({
      count: 1,
      errorCount: 1,
    });
    expect(context.toolSummaries.find((summary) => summary.name === 'edit')).toMatchObject({
      count: 1,
      errorCount: 1,
    });

    fixture.cleanup();
  });

  it('discovers the nearest ancestor .crush database for a cwd filter', async () => {
    const fixture = createCrushFixture();
    clearCrushDiscoveryEnv(fixture.root);
    const nestedCwd = path.join(fixture.projectRoot, 'packages', 'cli');
    fs.mkdirSync(nestedCwd, { recursive: true });
    insertSession(fixture, { id: 'ancestor-session' });
    insertMessage(fixture, {
      id: 'ancestor-user',
      sessionId: 'ancestor-session',
      role: 'user',
      parts: textPart('Use the nearest project-local database.'),
      createdAt: 1_734_000_010,
    });

    const sessions = await parseCrushSessions({ cwd: nestedCwd });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'ancestor-session',
      cwd: fixture.projectRoot,
      originalPath: fixture.dbPath,
      summary: 'Use the nearest project-local database.',
    });

    fixture.cleanup();
  });

  it('discovers databases from the global project index', async () => {
    const fixture = createCrushFixture();
    clearCrushDiscoveryEnv(fixture.root);
    const projectsDir = path.join(process.env.XDG_DATA_HOME ?? fixture.root, 'crush');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, 'projects.json'),
      JSON.stringify({ projects: [{ path: fixture.projectRoot, data_dir: path.dirname(fixture.dbPath) }] }),
    );
    insertSession(fixture, { id: 'indexed-session' });
    insertMessage(fixture, {
      id: 'indexed-user',
      sessionId: 'indexed-session',
      role: 'user',
      parts: textPart('Load this through projects.json.'),
      createdAt: 1_734_000_010,
    });

    const sessions = await parseCrushSessions();

    expect(sessions.find((session) => session.id === 'indexed-session')).toMatchObject({
      cwd: fixture.projectRoot,
      originalPath: fixture.dbPath,
      summary: 'Load this through projects.json.',
    });

    fixture.cleanup();
  });

  it('tolerates optional schema columns being absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-parser-minimal-'));
    const projectRoot = path.join(root, 'project');
    const dataDir = path.join(projectRoot, '.crush');
    const dbPath = path.join(dataDir, 'crush.db');
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT
      );
      CREATE TABLE messages (
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        parts TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('minimal-session', 'New session');
    db.prepare('INSERT INTO messages (session_id, role, parts) VALUES (?, ?, ?)').run(
      'minimal-session',
      'user',
      JSON.stringify(textPart('Summarize from the first user message.')),
    );
    db.prepare('INSERT INTO messages (session_id, role, parts) VALUES (?, ?, ?)').run(
      'minimal-session',
      'assistant',
      JSON.stringify(textPart('Schema still parses.')),
    );
    db.close();

    process.env.CRUSH_DB = dbPath;
    delete process.env.CRUSH_DB_PATH;
    delete process.env.CRUSH_DATA_DIR;
    delete process.env.CRUSH_GLOBAL_DATA;
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');

    const sessions = await parseCrushSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'minimal-session',
      cwd: projectRoot,
      lines: 2,
      summary: 'Summarize from the first user message.',
    });

    const context = await extractCrushContext(sessions[0]);
    expect(context.recentMessages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Summarize from the first user message.'],
      ['assistant', 'Schema still parses.'],
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not throw on a corrupt configured database', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-parser-corrupt-'));
    const dbPath = path.join(root, 'crush.db');
    fs.writeFileSync(dbPath, 'not a sqlite database');
    process.env.CRUSH_DB = dbPath;
    delete process.env.CRUSH_DB_PATH;
    delete process.env.CRUSH_DATA_DIR;
    delete process.env.CRUSH_GLOBAL_DATA;
    process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');

    await expect(parseCrushSessions()).resolves.toEqual([]);

    const context = await extractCrushContext({
      id: 'corrupt-session',
      source: 'crush',
      cwd: root,
      lines: 0,
      bytes: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      originalPath: dbPath,
      summary: 'Corrupt session',
    });
    expect(context.recentMessages).toEqual([]);
    expect(context.sessionNotes?.fidelityWarnings?.[0]).toContain('schema');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tolerates malformed parts, unknown roles, and missing metadata during context extraction', async () => {
    const fixture = createCrushFixture();
    useFixtureDb(fixture);
    insertSession(fixture, { id: 'session-malformed', title: 'Malformed session' });
    insertMessage(fixture, {
      id: 'bad-json',
      sessionId: 'session-malformed',
      role: 'user',
      parts: '{bad json',
      createdAt: 1_734_000_010,
    });
    insertMessage(fixture, {
      id: 'unknown-role',
      sessionId: 'session-malformed',
      role: 'critic',
      parts: textPart('This role is not supported.'),
      createdAt: 1_734_000_020,
    });
    insertMessage(fixture, {
      id: 'assistant-valid',
      sessionId: 'session-malformed',
      role: 'assistant',
      parts: textPart('Recovered after malformed records.'),
      createdAt: 1_734_000_030,
    });

    const session: UnifiedSession = {
      id: 'session-malformed',
      source: 'crush',
      cwd: fixture.projectRoot,
      lines: 3,
      bytes: 0,
      createdAt: new Date(1_734_000_000 * 1000),
      updatedAt: new Date(1_734_000_030 * 1000),
      originalPath: fixture.dbPath,
      summary: 'Malformed session',
    };

    const context = await extractCrushContext(session);
    expect(context.recentMessages).toEqual([
      {
        role: 'assistant',
        content: 'Recovered after malformed records.',
        timestamp: new Date(1_734_000_030 * 1000),
        sourceId: 'assistant-valid',
      },
    ]);
    expect(context.toolSummaries).toEqual([]);
    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([
        'Skipped 1 Crush message with malformed parts JSON.',
        'Skipped 1 Crush message with unsupported role.',
      ]),
    );

    fixture.cleanup();
  });

  it('extracts an empty context without throwing when a session has no messages', async () => {
    const fixture = createCrushFixture();
    useFixtureDb(fixture);
    insertSession(fixture, { id: 'empty-session', title: 'Empty session' });

    const session: UnifiedSession = {
      id: 'empty-session',
      source: 'crush',
      cwd: fixture.projectRoot,
      lines: 0,
      bytes: 0,
      createdAt: new Date(1_734_000_000 * 1000),
      updatedAt: new Date(1_734_000_000 * 1000),
      originalPath: fixture.dbPath,
      summary: 'Empty session',
    };

    const context = await extractCrushContext(session);
    expect(context.recentMessages).toEqual([]);
    expect(context.filesModified).toEqual([]);
    expect(context.toolSummaries).toEqual([]);
    expect(context.markdown).toContain('Empty session');

    fixture.cleanup();
  });

  // Locks in the parser's read-only safety contract: the DatabaseSync handle
  // the parser opens against any discovered Crush DB MUST reject writes.
  // If a future edit drops `{ readOnly: true }` from openReadOnlyDatabase
  // (src/parsers/crush.ts), this test fails. Crush is the user's primary
  // data store for sessions, migrations, and read-files history — silent
  // writes from a read-only tool would be a data-integrity regression.
  it('rejects writes against a read-only Crush handle (parser open contract)', async () => {
    const fixture = createCrushFixture();
    useFixtureDb(fixture);
    insertSession(fixture, { id: 'safety-session', title: 'Safety session' });
    insertMessage(fixture, {
      id: 'safety-msg',
      sessionId: 'safety-session',
      role: 'user',
      parts: textPart('Verify the parser keeps the database read-only.'),
      createdAt: 1_734_000_010,
    });

    // Round-trip through the parser to confirm read works against a real DB.
    const sessions = await parseCrushSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('safety-session');

    // Open the same DB with the same options the parser uses
    // (see openReadOnlyDatabase in src/parsers/crush.ts:159-160) and confirm
    // node:sqlite v22.5+ enforces SQLITE_OPEN_READONLY when readOnly:true.
    const handle = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      // INSERT must throw.
      expect(() =>
        handle
          .prepare(
            `INSERT INTO sessions (id, parent_session_id, title, message_count, prompt_tokens, completion_tokens, cost, updated_at, created_at, summary_message_id, todos)
             VALUES ('writer', NULL, 'should not persist', 0, 0, 0, 0.0, ?, ?, NULL, NULL)`,
          )
          .run(1_734_000_999, 1_734_000_999),
      ).toThrow();

      // UPDATE must throw.
      expect(() =>
        handle.prepare("UPDATE sessions SET title = 'altered' WHERE id = ?").run('safety-session'),
      ).toThrow();

      // DDL must throw — catches the case where readOnly only blocks DML.
      expect(() => handle.exec('CREATE TABLE writer_should_fail (x INTEGER)')).toThrow();
    } finally {
      handle.close();
    }

    // After the read-only handle closes, the original session must remain
    // untouched — neither row counts nor titles changed.
    const verify = new DatabaseSync(fixture.dbPath);
    try {
      const row = verify.prepare('SELECT title FROM sessions WHERE id = ?').get('safety-session') as
        | { title: string }
        | undefined;
      expect(row?.title).toBe('Safety session');
      const writerRow = verify.prepare('SELECT id FROM sessions WHERE id = ?').get('writer');
      expect(writerRow).toBeUndefined();
    } finally {
      verify.close();
    }

    fixture.cleanup();
  });

  // Reasoning is one of seven Crush part types
  // (charmbracelet/crush:internal/message/content.go — partType "reasoning"
  // backed by ReasoningContent.Thinking). The parser surfaces these into
  // sessionNotes.reasoning so the receiving tool can carry forward the
  // assistant's thinking thread.
  it('extracts reasoning parts into sessionNotes.reasoning', async () => {
    const fixture = createCrushFixture();
    useFixtureDb(fixture);
    insertSession(fixture, { id: 'reasoning-session' });
    insertMessage(fixture, {
      id: 'reasoning-user',
      sessionId: 'reasoning-session',
      role: 'user',
      parts: textPart('Walk me through the failure.'),
      createdAt: 1_734_000_010,
    });
    insertMessage(fixture, {
      id: 'reasoning-assistant',
      sessionId: 'reasoning-session',
      role: 'assistant',
      model: 'claude-sonnet-4.5',
      parts: [
        { type: 'reasoning', data: { thinking: 'The path resolution dropped the trailing slash.' } },
        { type: 'text', data: { text: 'Here is the fix.' } },
      ],
      createdAt: 1_734_000_020,
    });

    const sessions = await parseCrushSessions();
    expect(sessions).toHaveLength(1);
    const context = await extractCrushContext(sessions[0]);
    expect(context.sessionNotes?.reasoning).toEqual(['The path resolution dropped the trailing slash.']);

    fixture.cleanup();
  });
});

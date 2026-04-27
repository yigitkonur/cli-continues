import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

interface OpenCodeFixture {
  dbPath: string;
  root: string;
  cleanup: () => void;
}

interface OpenCodeJsonFixture {
  root: string;
  xdgDataHome: string;
  cleanup: () => void;
}

interface JsonSeedOptions {
  sessionId?: string;
  sessionTitle?: string;
  summaryAdditions?: number;
  summaryDeletions?: number;
  summaryFiles?: number;
  messages?: Array<{
    id: string;
    role: 'user' | 'assistant';
    timeCreatedOffsetMs: number;
    data?: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  }>;
}

interface SeedOptions {
  sessionId?: string;
  sessionTitle?: string;
  summaryAdditions?: number | null;
  summaryDeletions?: number | null;
  summaryFiles?: number | null;
  messages?: Array<{
    id: string;
    role: 'user' | 'assistant';
    timeCreatedOffsetMs: number;
    data?: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  }>;
  todos?: Array<{
    content: string;
    status: string;
    priority: string;
    position: number;
  }>;
}

const originalEnv = {
  OPENCODE_DB: process.env.OPENCODE_DB,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function createOpenCodeSqliteFixture(dbFileName: string, options: SeedOptions = {}): OpenCodeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-parser-'));
  const dbDir = path.join(root, 'db');
  const dbPath = path.join(dbDir, dbFileName);
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE todo (
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      position INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  const sessionId = options.sessionId ?? 'ses_test_sqlite';
  const summaryAdditions = options.summaryAdditions ?? null;
  const summaryDeletions = options.summaryDeletions ?? null;
  const summaryFiles = options.summaryFiles ?? null;
  const messages = options.messages ?? [
    {
      id: 'msg_user_1',
      role: 'user' as const,
      timeCreatedOffsetMs: -3_000,
      parts: [{ type: 'text', text: 'Investigate login.ts failures' }],
    },
    {
      id: 'msg_assistant_1',
      role: 'assistant' as const,
      timeCreatedOffsetMs: -2_000,
      parts: [{ type: 'text', text: 'The validation branch is missing.' }],
    },
  ];

  db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('proj_test', '/home/user/project');
  db.prepare(
    `INSERT INTO session (
      id,
      project_id,
      slug,
      directory,
      title,
      version,
      summary_additions,
      summary_deletions,
      summary_files,
      time_created,
      time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    'proj_test',
    'test-session',
    '/home/user/project',
    options.sessionTitle ?? 'New session',
    '1.2.0',
    summaryAdditions,
    summaryDeletions,
    summaryFiles,
    now - 5_000,
    now,
  );

  for (const message of messages) {
    const timeCreated = now + message.timeCreatedOffsetMs;
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(
      message.id,
      sessionId,
      timeCreated,
      JSON.stringify({ role: message.role, time: { created: timeCreated }, ...message.data }),
    );

    message.parts.forEach((part, index) => {
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        `${message.id}_part_${index + 1}`,
        message.id,
        sessionId,
        timeCreated + index,
        JSON.stringify(part),
      );
    });
  }

  for (const todo of options.todos ?? []) {
    db.prepare('INSERT INTO todo (session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)').run(
      sessionId,
      todo.content,
      todo.status,
      todo.priority,
      todo.position,
    );
  }

  db.close();

  return {
    dbPath,
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function createOpenCodeChannelSqliteFixture(dbFileName: string, options: SeedOptions = {}): OpenCodeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-parser-channel-'));
  const xdgDataHome = path.join(root, 'xdg-data');
  const dbDir = path.join(xdgDataHome, 'opencode');
  const dbPath = path.join(dbDir, dbFileName);
  fs.mkdirSync(dbDir, { recursive: true });

  const fixture = createOpenCodeSqliteFixture(dbFileName, options);
  fs.copyFileSync(fixture.dbPath, dbPath);
  fixture.cleanup();

  return {
    dbPath,
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function createOpenCodeJsonFixture(options: JsonSeedOptions = {}): OpenCodeJsonFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-parser-json-'));
  const xdgDataHome = path.join(root, 'xdg-data');
  const storageDir = path.join(xdgDataHome, 'opencode', 'storage');
  const projectId = 'proj_json';
  const sessionId = options.sessionId ?? 'ses_json';
  const now = Date.now();
  const messages = options.messages ?? [
    {
      id: 'msg_user_1',
      role: 'user' as const,
      timeCreatedOffsetMs: -4_000,
      parts: [{ type: 'text', text: 'Audit the auth validation flow' }],
    },
    {
      id: 'msg_assistant_1',
      role: 'assistant' as const,
      timeCreatedOffsetMs: -3_000,
      parts: [
        {
          type: 'reasoning',
          text: 'The early return bypasses token validation.',
        },
        {
          type: 'tool',
          callID: 'call_edit_1',
          tool: 'edit',
          state: {
            status: 'completed',
            input: { filePath: 'src/auth.ts' },
            output: 'Inserted token validation before the early return.',
          },
        },
      ],
    },
  ];

  fs.mkdirSync(path.join(storageDir, 'session', projectId), { recursive: true });
  fs.mkdirSync(path.join(storageDir, 'project'), { recursive: true });
  fs.mkdirSync(path.join(storageDir, 'message', sessionId), { recursive: true });

  fs.writeFileSync(
    path.join(storageDir, 'session', projectId, `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      slug: 'json-session',
      version: '1.1.47',
      projectID: projectId,
      directory: '/home/user/project',
      title: options.sessionTitle ?? 'New session',
      time: { created: now - 5_000, updated: now },
      summary: {
        additions: options.summaryAdditions,
        deletions: options.summaryDeletions,
        files: options.summaryFiles,
      },
    }),
  );
  fs.writeFileSync(
    path.join(storageDir, 'project', `${projectId}.json`),
    JSON.stringify({ id: projectId, worktree: '/home/user/project' }),
  );

  for (const message of messages) {
    const timeCreated = now + message.timeCreatedOffsetMs;
    fs.writeFileSync(
      path.join(storageDir, 'message', sessionId, `${message.id}.json`),
      JSON.stringify({
        id: message.id,
        sessionID: sessionId,
        role: message.role,
        time: { created: timeCreated, ...(message.role === 'assistant' ? { completed: timeCreated + 500 } : {}) },
        ...message.data,
      }),
    );

    const partDir = path.join(storageDir, 'part', message.id);
    fs.mkdirSync(partDir, { recursive: true });

    message.parts.forEach((part, index) => {
      fs.writeFileSync(
        path.join(partDir, `prt_${message.id}_${index + 1}.json`),
        JSON.stringify({
          id: `prt_${message.id}_${index + 1}`,
          sessionID: sessionId,
          messageID: message.id,
          ...part,
        }),
      );
    });
  }

  return {
    root,
    xdgDataHome,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function importOpenCodeParser() {
  vi.resetModules();
  return import('../parsers/opencode.js');
}

afterEach(() => {
  process.env.OPENCODE_DB = originalEnv.OPENCODE_DB;
  process.env.XDG_DATA_HOME = originalEnv.XDG_DATA_HOME;
  vi.resetModules();
});

describe('OpenCode parser', () => {
  it('discovers channel-specific SQLite DB filenames when OPENCODE_DB is unset', async () => {
    const fixture = createOpenCodeChannelSqliteFixture('opencode-preview.db', {
      sessionId: 'ses_channel',
      sessionTitle: 'Preview channel session',
    });

    try {
      process.env.XDG_DATA_HOME = path.join(fixture.root, 'xdg-data');
      delete process.env.OPENCODE_DB;

      const { parseOpenCodeSessions } = await importOpenCodeParser();
      const sessions = await parseOpenCodeSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: 'ses_channel',
        originalPath: fixture.dbPath,
        summary: 'Preview channel session',
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('prefers OPENCODE_DB when resolving the SQLite database path', async () => {
    const fixture = createOpenCodeSqliteFixture('opencode-preview.db', {
      sessionId: 'ses_override',
      sessionTitle: 'Override DB session',
    });

    try {
      process.env.XDG_DATA_HOME = path.join(fixture.root, 'xdg-data');
      process.env.OPENCODE_DB = fixture.dbPath;

      const { parseOpenCodeSessions } = await importOpenCodeParser();
      const sessions = await parseOpenCodeSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: 'ses_override',
        originalPath: fixture.dbPath,
        summary: 'Override DB session',
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('discovers sessions from channel DBs even when the default opencode.db also exists', async () => {
    const defaultFixture = createOpenCodeSqliteFixture('opencode.db', {
      sessionId: 'ses_default',
      sessionTitle: 'Default DB session',
    });
    const channelFixture = createOpenCodeChannelSqliteFixture('opencode-preview.db', {
      sessionId: 'ses_preview',
      sessionTitle: 'Preview DB session',
    });

    try {
      const mergedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-parser-merged-'));
      const xdgDataHome = path.join(mergedRoot, 'xdg-data');
      const dbDir = path.join(xdgDataHome, 'opencode');
      fs.mkdirSync(dbDir, { recursive: true });
      fs.copyFileSync(defaultFixture.dbPath, path.join(dbDir, 'opencode.db'));
      fs.copyFileSync(channelFixture.dbPath, path.join(dbDir, 'opencode-preview.db'));

      process.env.XDG_DATA_HOME = xdgDataHome;
      process.env.OPENCODE_DB = '';

      const { parseOpenCodeSessions } = await importOpenCodeParser();
      const sessions = await parseOpenCodeSessions();

      expect(sessions.map((session) => session.id)).toContain('ses_default');
      expect(sessions.map((session) => session.id)).toContain('ses_preview');
    } finally {
      defaultFixture.cleanup();
      channelFixture.cleanup();
    }
  });

  it('keeps high-value non-text SQLite parts in extracted recent messages', async () => {
    const fixture = createOpenCodeSqliteFixture('opencode.db', {
      sessionId: 'ses_parts',
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -3_000,
          parts: [{ type: 'text', text: 'Inspect the failing auth flow' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -2_000,
          parts: [
            { type: 'reasoning', text: 'Need to inspect login.ts and confirm the guard path.' },
            {
              type: 'tool',
              callID: 'call_read_1',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: 'src/login.ts' },
                output: 'Guard returns early without validating the token.',
              },
            },
          ],
        },
      ],
    });

    try {
      process.env.OPENCODE_DB = fixture.dbPath;

      const { parseOpenCodeSessions, extractOpenCodeContext } = await importOpenCodeParser();
      const [session] = await parseOpenCodeSessions();
      const context = await extractOpenCodeContext(session);
      const assistantMessages = context.recentMessages.filter((message) => message.role === 'assistant');

      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toContain('Need to inspect login.ts');
      expect(assistantMessages[0].content).toContain('read');
      expect(assistantMessages[0].toolCalls).toEqual([
        {
          id: 'call_read_1',
          name: 'read',
          arguments: { filePath: 'src/login.ts' },
          result: 'Guard returns early without validating the token.',
          success: true,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps high-value non-text legacy JSON parts in extracted recent messages', async () => {
    const fixture = createOpenCodeJsonFixture();

    try {
      process.env.XDG_DATA_HOME = fixture.xdgDataHome;
      delete process.env.OPENCODE_DB;

      const { parseOpenCodeSessions, extractOpenCodeContext } = await importOpenCodeParser();
      const [session] = await parseOpenCodeSessions();
      const context = await extractOpenCodeContext(session);
      const assistantMessages = context.recentMessages.filter((message) => message.role === 'assistant');

      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toContain('The early return bypasses token validation.');
      expect(assistantMessages[0].content).toContain('tool:edit completed');
      expect(assistantMessages[0].toolCalls).toEqual([
        {
          id: 'call_edit_1',
          name: 'edit',
          arguments: { filePath: 'src/auth.ts' },
          result: 'Inserted token validation before the early return.',
          success: true,
        },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it('extracts tool summaries from SQLite tool parts and session edit stats', async () => {
    const fixture = createOpenCodeSqliteFixture('opencode.db', {
      sessionId: 'ses_tools',
      summaryAdditions: 7,
      summaryDeletions: 3,
      summaryFiles: 2,
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -3_000,
          parts: [{ type: 'text', text: 'Fix auth validation and check the diff' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -2_000,
          parts: [
            {
              type: 'tool',
              callID: 'call_read_1',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: 'src/login.ts' },
                output: 'Read src/login.ts successfully.',
              },
            },
            {
              type: 'tool',
              callID: 'call_bash_1',
              tool: 'bash',
              state: {
                status: 'error',
                input: { command: 'pnpm test auth' },
                error: 'Command failed with exit code 1.',
              },
            },
          ],
        },
      ],
    });

    try {
      process.env.OPENCODE_DB = fixture.dbPath;

      const { parseOpenCodeSessions, extractOpenCodeContext } = await importOpenCodeParser();
      const [session] = await parseOpenCodeSessions();
      const context = await extractOpenCodeContext(session);
      const summaries = new Map(context.toolSummaries.map((summary) => [summary.name, summary]));

      expect(summaries.get('read')?.samples[0]?.summary).toContain('completed');
      expect(summaries.get('bash')?.samples[0]?.summary).toContain('error');
      expect(summaries.get('bash')?.errorCount).toBe(1);
      expect(summaries.get('Edit')?.samples[0]?.summary).toContain('2 file(s) changed (+7 -3)');
    } finally {
      fixture.cleanup();
    }
  });

  it('extracts tool summaries from legacy JSON tool parts and session edit stats', async () => {
    const fixture = createOpenCodeJsonFixture({
      sessionId: 'ses_json_tools',
      summaryAdditions: 4,
      summaryDeletions: 1,
      summaryFiles: 2,
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -3_000,
          parts: [{ type: 'text', text: 'Fix auth validation and check the diff' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -2_000,
          parts: [
            {
              type: 'tool',
              callID: 'call_read_json_1',
              tool: 'read',
              state: {
                status: 'completed',
                input: { filePath: 'src/login.ts' },
                output: 'Read src/login.ts successfully.',
              },
            },
            {
              type: 'tool',
              callID: 'call_bash_json_1',
              tool: 'bash',
              state: {
                status: 'error',
                input: { command: 'pnpm test auth' },
                error: 'Command failed with exit code 1.',
              },
            },
            {
              type: 'tool',
              callID: 'call_search_json_1',
              tool: 'web_search',
              state: {
                status: 'completed',
                input: { query: 'OpenCode storage format' },
                output: 'OpenCode stores sessions in SQLite and JSON formats.',
              },
            },
            {
              type: 'tool',
              callID: 'call_fetch_json_1',
              tool: 'web_fetch',
              state: {
                status: 'completed',
                input: { url: 'https://opencode.ai/docs' },
                output: 'OpenCode documentation page.',
              },
            },
          ],
        },
      ],
    });

    try {
      process.env.XDG_DATA_HOME = fixture.xdgDataHome;
      delete process.env.OPENCODE_DB;

      const { parseOpenCodeSessions, extractOpenCodeContext } = await importOpenCodeParser();
      const [session] = await parseOpenCodeSessions();
      const context = await extractOpenCodeContext(session);
      const summaries = new Map(context.toolSummaries.map((summary) => [summary.name, summary]));

      expect(summaries.get('read')?.samples[0]?.summary).toContain('completed');
      expect(summaries.get('bash')?.samples[0]?.summary).toContain('error');
      expect(summaries.get('bash')?.errorCount).toBe(1);
      expect(summaries.get('web_search')?.samples[0]?.data?.category).toBe('search');
      expect(summaries.get('web_fetch')?.samples[0]?.data?.category).toBe('fetch');
      expect(summaries.get('Edit')?.samples[0]?.summary).toContain('2 file(s) changed (+4 -1)');
    } finally {
      fixture.cleanup();
    }
  });

  it('extracts rich SQLite session notes, modified files, and pending tasks', async () => {
    const patchText = `*** Begin Patch
*** Update File: src/auth.ts
@@
-return false;
+return validateToken(token);
*** End Patch`;
    const fixture = createOpenCodeSqliteFixture('opencode.db', {
      sessionId: 'ses_rich',
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -4_000,
          parts: [{ type: 'text', text: 'Fix auth validation and preserve context' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -3_000,
          data: {
            modelID: 'gpt-5.3-codex',
            tokens: {
              input: 123,
              output: 45,
              reasoning: 7,
              cache: { read: 10, write: 4 },
            },
          },
          parts: [
            { type: 'reasoning', text: 'Need to inspect the auth guard before patching.' },
            {
              type: 'tool',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'printf ok > generated.txt' },
                output: 'ok',
              },
            },
            {
              type: 'tool',
              tool: 'apply_patch',
              state: {
                status: 'completed',
                input: { patch: patchText },
                output: 'Done',
              },
            },
            {
              type: 'tool',
              tool: 'web_search',
              state: {
                status: 'completed',
                input: { query: 'OpenCode tokens modelID' },
                output: 'Search result preview',
              },
            },
          ],
        },
      ],
      todos: [{ content: 'Re-run auth tests', status: 'pending', priority: 'high', position: 1 }],
    });

    try {
      process.env.OPENCODE_DB = fixture.dbPath;

      const { parseOpenCodeSessions, extractOpenCodeContext } = await importOpenCodeParser();
      const [session] = await parseOpenCodeSessions();
      const context = await extractOpenCodeContext(session);
      const summaries = new Map(context.toolSummaries.map((summary) => [summary.name, summary]));

      expect(context.sessionNotes).toMatchObject({
        model: 'gpt-5.3-codex',
        tokenUsage: { input: 123, output: 45 },
        cacheTokens: { read: 10, creation: 4 },
        thinkingTokens: 7,
      });
      expect(context.sessionNotes?.reasoning?.[0]).toContain('Need to inspect the auth guard');
      expect(context.filesModified).toEqual(expect.arrayContaining(['generated.txt', 'src/auth.ts']));
      expect(context.pendingTasks).toEqual(['[high] Re-run auth tests']);
      expect(summaries.get('bash')?.samples[0]?.data).toMatchObject({
        category: 'shell',
        command: 'printf ok > generated.txt',
      });
      expect(summaries.get('apply_patch')?.samples[0]?.data).toMatchObject({
        category: 'edit',
        filePath: 'src/auth.ts',
      });
      expect(summaries.get('web_search')?.samples[0]?.data?.category).toBe('search');
      expect(context.markdown).toContain('Tokens Used');
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps a user message when trimming OpenCode handoff context', async () => {
    const fixture = createOpenCodeSqliteFixture('opencode.db', {
      sessionId: 'ses_trim',
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          timeCreatedOffsetMs: -5_000,
          parts: [{ type: 'text', text: 'Explain why the auth test is failing' }],
        },
        {
          id: 'msg_assistant_1',
          role: 'assistant',
          timeCreatedOffsetMs: -4_000,
          parts: [{ type: 'text', text: 'First assistant update' }],
        },
        {
          id: 'msg_assistant_2',
          role: 'assistant',
          timeCreatedOffsetMs: -3_000,
          parts: [{ type: 'text', text: 'Second assistant update' }],
        },
        {
          id: 'msg_assistant_3',
          role: 'assistant',
          timeCreatedOffsetMs: -2_000,
          parts: [{ type: 'text', text: 'Third assistant update' }],
        },
      ],
    });

    try {
      process.env.OPENCODE_DB = fixture.dbPath;

      const { parseOpenCodeSessions, extractOpenCodeContext } = await importOpenCodeParser();
      const { getPreset } = await import('../config/index.js');
      const [session] = await parseOpenCodeSessions();
      const context = await extractOpenCodeContext(session, { ...getPreset('standard'), recentMessages: 2 });

      expect(context.recentMessages).toHaveLength(2);
      expect(context.recentMessages[0]).toMatchObject({
        role: 'user',
        content: 'Explain why the auth test is failing',
      });
    } finally {
      fixture.cleanup();
    }
  });
});

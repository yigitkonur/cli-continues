import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSource, UnifiedSession } from '../types/index.js';

const require = createRequire(import.meta.url);
const tempDirs: string[] = [];

interface SqlitePreparedStatement {
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}
interface LoadClineParserOptions {
  onReadFile?: (filePath: string) => void;
}

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-parser-'));
  tempDirs.push(dir);
  return dir;
}

function globalStorageBase(home: string): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Code', 'User', 'globalStorage');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage');
  }
  return path.join(home, '.config', 'Code', 'User', 'globalStorage');
}

function clineCliTasksRoot(clineDir: string): string {
  return path.join(clineDir, 'data', 'tasks');
}

function jetBrainsRoot(home: string): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'JetBrains');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'JetBrains');
  }
  return path.join(home, '.config', 'JetBrains');
}

/**
 * VS Code-fork globalStorage base. Cursor and Windsurf both ship a VS Code
 * fork that reuses the same per-platform layout. The Cline extension can be
 * installed inside any of them and stores tasks under its own publisher dir.
 */
function ideGlobalStorageBase(home: string, ide: 'Code' | 'Cursor' | 'Windsurf' | 'Code - Insiders'): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', ide, 'User', 'globalStorage');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', ide, 'User', 'globalStorage');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', ide, 'User', 'globalStorage');
  }
  return path.join(home, '.config', ide, 'User', 'globalStorage');
}

async function loadClineParser(
  home: string,
  options: LoadClineParserOptions = {},
): Promise<typeof import('../parsers/cline.js')> {
  vi.resetModules();
  if (options.onReadFile) {
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readFile: (
          filePath: Parameters<typeof actual.readFile>[0],
          readOptions?: Parameters<typeof actual.readFile>[1],
        ) => {
          options.onReadFile?.(String(filePath));
          return actual.readFile(filePath, readOptions);
        },
      };
    });
  }
  vi.stubEnv('APPDATA', path.join(home, 'AppData', 'Roaming'));
  vi.doMock('../utils/parser-helpers.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/parser-helpers.js')>();
    return {
      ...actual,
      homeDir: () => home,
    };
  });
  vi.doMock('../utils/markdown.js', () => ({
    generateHandoffMarkdown: () => 'mock handoff markdown',
  }));
  return import('../parsers/cline.js');
}

function writeTaskAtRoot(tasksRoot: string, taskId: string, messages: unknown[]): string {
  const taskDir = path.join(tasksRoot, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
  return filePath;
}

function writeRawTaskAtRoot(tasksRoot: string, taskId: string, content: string): string {
  const taskDir = path.join(tasksRoot, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function extensionTasksRoot(home: string, extensionId: string): string {
  return path.join(globalStorageBase(home), extensionId, 'tasks');
}

function writeTask(home: string, extensionId: string, taskId: string, messages: unknown[]): string {
  return writeTaskAtRoot(extensionTasksRoot(home, extensionId), taskId, messages);
}

function writeRawTask(home: string, extensionId: string, taskId: string, content: string): string {
  return writeRawTaskAtRoot(extensionTasksRoot(home, extensionId), taskId, content);
}

function taskDirFor(originalPath: string): string {
  return path.dirname(originalPath);
}

function writeCompanion(originalPath: string, fileName: string, content: unknown): string {
  const filePath = path.join(taskDirFor(originalPath), fileName);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
  return filePath;
}

function writeTaskHistory(originalPath: string, items: unknown[]): string {
  const storageRoot = path.dirname(path.dirname(taskDirFor(originalPath)));
  const stateDir = path.join(storageRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, 'taskHistory.json');
  fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf8');
  return filePath;
}

function sessionFor(source: SessionSource, originalPath: string, id = `${source}-task`): UnifiedSession {
  return {
    id,
    source,
    cwd: '',
    lines: 1,
    bytes: fs.statSync(originalPath).size,
    createdAt: new Date('2026-04-15T10:00:00.000Z'),
    updatedAt: new Date('2026-04-15T10:00:00.000Z'),
    originalPath,
    summary: 'Parser hardening',
  } satisfies UnifiedSession;
}

function openWritableSqlite(dbPath: string): SqliteDatabase {
  const sqliteModule = require('node:sqlite') as {
    DatabaseSync: new (database: string) => SqliteDatabase;
  };
  return new sqliteModule.DatabaseSync(dbPath);
}

function writeKiloDb(root: string, dbName = 'kilo.db'): string {
  const dbPath = path.join(root, dbName);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openWritableSqlite(dbPath);
  const created = Date.parse('2026-04-16T10:00:00.000Z');
  const updated = Date.parse('2026-04-16T10:03:00.000Z');

  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
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
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

    db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('proj_kilo', '/tmp/kilo-project');
    db.prepare(
      'INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'ses_kilo_db',
      'proj_kilo',
      'kilo-db-session',
      '/tmp/kilo-project',
      'New session',
      '7.1.17',
      created,
      updated,
    );

    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'msg_user',
      'ses_kilo_db',
      created,
      created,
      JSON.stringify({ role: 'user' }),
    );
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'part_user',
      'msg_user',
      'ses_kilo_db',
      created,
      created,
      JSON.stringify({ type: 'text', text: 'Build DB-backed Kilo support' }),
    );
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'msg_assistant',
      'ses_kilo_db',
      updated,
      updated,
      JSON.stringify({
        role: 'assistant',
        modelID: 'claude-sonnet-4',
        tokens: { input: 12, output: 34, reasoning: 5, cache: { read: 3, write: 2 } },
      }),
    );
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'part_assistant',
      'msg_assistant',
      'ses_kilo_db',
      updated,
      updated,
      JSON.stringify({ type: 'text', text: 'Kilo DB sessions are now parsed safely.' }),
    );
  } finally {
    db.close();
  }

  return dbPath;
}

function writeUnsupportedKiloDb(root: string): string {
  const dbPath = path.join(root, 'kilo.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openWritableSqlite(dbPath);
  try {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY);');
  } finally {
    db.close();
  }
  return dbPath;
}

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('../utils/parser-helpers.js');
  vi.doUnmock('../utils/markdown.js');
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('Cline-family parser hardening', () => {
  it('discovers Cline CLI task roots from CLINE_DIR and ~/.cline without affecting Roo/Kilo', async () => {
    const home = makeHome();
    const customClineDir = path.join(home, 'custom-cline-dir');
    vi.stubEnv('CLINE_DIR', customClineDir);

    writeTaskAtRoot(clineCliTasksRoot(customClineDir), 'env-cli-task', [
      { ts: 1770000000000, type: 'say', say: 'task', text: 'Parse task from CLINE_DIR' },
    ]);
    writeTaskAtRoot(path.join(home, '.cline', 'data', 'tasks'), 'home-cli-task', [
      { ts: 1770000001000, type: 'say', say: 'task', text: 'Parse task from home Cline dir' },
    ]);

    const { parseClineSessions, parseRooCodeSessions, parseKiloCodeSessions } = await loadClineParser(home);

    const clineSessions = await parseClineSessions();
    const rooSessions = await parseRooCodeSessions();
    const kiloSessions = await parseKiloCodeSessions();

    expect(clineSessions.map((session) => session.id).sort()).toEqual(['env-cli-task', 'home-cli-task']);
    expect(clineSessions.every((session) => session.source === 'cline')).toBe(true);
    expect(clineSessions.map((session) => session.summary).sort()).toEqual([
      'Parse task from CLINE_DIR',
      'Parse task from home Cline dir',
    ]);
    expect(rooSessions).toEqual([]);
    expect(kiloSessions).toEqual([]);
  });

  it('discovers and labels Cline, Roo Code, and Kilo Code task storage variants', async () => {
    const home = makeHome();
    writeTask(home, 'saoudrizwan.claude-dev', 'cline-task', [
      { ts: 1770000000000, type: 'say', say: 'task', text: 'Build the Cline parser fixture' },
    ]);
    writeTask(home, 'rooveterinaryinc.roo-cline', 'roo-legacy-task', [
      { ts: 1770000001000, type: 'say', say: 'text', text: 'Build the legacy Roo parser fixture' },
    ]);
    writeTask(home, 'roo-code.roo-cline', 'roo-current-task', [
      { ts: 1770000002000, type: 'say', say: 'text', text: 'Build the current Roo parser fixture' },
    ]);
    writeTask(home, 'kilocode.kilo-code', 'kilo-task', [
      { ts: 1770000003000, type: 'say', say: 'text', text: 'Build the Kilo parser fixture' },
    ]);

    const { parseClineSessions, parseRooCodeSessions, parseKiloCodeSessions } = await loadClineParser(home);

    const clineSessions = await parseClineSessions();
    const rooSessions = await parseRooCodeSessions();
    const kiloSessions = await parseKiloCodeSessions();

    expect(clineSessions).toHaveLength(1);
    expect(clineSessions[0]).toMatchObject({
      id: 'cline-task',
      source: 'cline',
      summary: 'Build the Cline parser fixture',
    });
    expect(clineSessions[0].originalPath).toContain('saoudrizwan.claude-dev');

    expect(rooSessions.map((session) => session.id).sort()).toEqual(['roo-current-task', 'roo-legacy-task']);
    expect(rooSessions.every((session) => session.source === 'roo-code')).toBe(true);
    expect(rooSessions.map((session) => session.summary).sort()).toEqual([
      'Build the current Roo parser fixture',
      'Build the legacy Roo parser fixture',
    ]);

    expect(kiloSessions).toHaveLength(1);
    expect(kiloSessions[0]).toMatchObject({
      id: 'kilo-task',
      source: 'kilo-code',
      summary: 'Build the Kilo parser fixture',
    });
    expect(kiloSessions[0].originalPath).toContain('kilocode.kilo-code');
  });

  it('discovers and extracts Kilo Code sessions from XDG kilo.db storage while preserving legacy task support', async () => {
    const home = makeHome();
    const xdgDataHome = path.join(home, '.xdg-data');
    const dbPath = writeKiloDb(path.join(xdgDataHome, 'kilo'));
    writeTask(home, 'kilocode.kilo-code', 'kilo-legacy-task', [
      { ts: 1770000003000, type: 'say', say: 'text', text: 'Keep legacy Kilo task support' },
    ]);
    vi.stubEnv('XDG_DATA_HOME', xdgDataHome);

    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();

    expect(sessions.map((session) => session.id).sort()).toEqual(['kilo-legacy-task', 'ses_kilo_db']);

    const dbSession = sessions.find((session) => session.id === 'ses_kilo_db');
    expect(dbSession).toMatchObject({
      source: 'kilo-code',
      cwd: '/tmp/kilo-project',
      originalPath: dbPath,
      summary: 'Build DB-backed Kilo support',
      model: 'claude-sonnet-4',
      lines: 2,
    });

    const context = await extractKiloCodeContext(dbSession as UnifiedSession);

    expect(context.recentMessages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Build DB-backed Kilo support'],
      ['assistant', 'Kilo DB sessions are now parsed safely.'],
    ]);
    expect(context.session.model).toBe('claude-sonnet-4');
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 12, output: 34 });
    expect(context.sessionNotes?.thinkingTokens).toBe(5);
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 2, read: 3 });
    expect(context.sessionNotes?.rawAccess).toEqual({ kind: 'sqlite', path: dbPath });
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      storage: 'sqlite',
      dbPath,
      slug: 'kilo-db-session',
      version: '7.1.17',
      projectId: 'proj_kilo',
    });
    expect(context.sessionNotes?.fidelityWarnings).toBeUndefined();
  });

  it('uses explicit KILO_DB and tolerates unsupported Kilo SQLite schemas with fidelity warnings', async () => {
    const home = makeHome();
    const dbPath = writeUnsupportedKiloDb(home);
    vi.stubEnv('KILO_DB', dbPath);

    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();
    const context = await extractKiloCodeContext(sessionFor('kilo-code', dbPath));

    expect(sessions).toEqual([]);
    expect(context.recentMessages).toEqual([]);
    expect(context.sessionNotes?.fidelityWarnings).toEqual(
      expect.arrayContaining([
        'Kilo SQLite schema unsupported: missing "message" table.',
        'Kilo SQLite schema unsupported: missing "part" table.',
      ]),
    );
    expect(context.sessionNotes?.rawAccess).toEqual({ kind: 'sqlite', path: dbPath });
  });

  it('discovers and extracts Kilo Code sessions from an explicit KILO_DB path without requiring a .db suffix', async () => {
    const home = makeHome();
    const dbPath = writeKiloDb(path.join(home, 'custom-storage'), 'custom-kilo-store');
    vi.stubEnv('KILO_DB', dbPath);

    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'ses_kilo_db',
      source: 'kilo-code',
      originalPath: dbPath,
      summary: 'Build DB-backed Kilo support',
    });

    const context = await extractKiloCodeContext(sessions[0]);

    expect(context.recentMessages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Build DB-backed Kilo support'],
      ['assistant', 'Kilo DB sessions are now parsed safely.'],
    ]);
    expect(context.sessionNotes?.rawAccess).toEqual({ kind: 'sqlite', path: dbPath });
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      storage: 'sqlite',
      dbPath,
    });
  });

  it('skips invalid JSON, non-array JSON, malformed entries, and metadata-only tasks during discovery', async () => {
    const home = makeHome();
    writeRawTask(home, 'saoudrizwan.claude-dev', 'invalid-json', '{not valid json');
    writeRawTask(home, 'saoudrizwan.claude-dev', 'non-array-json', JSON.stringify({ type: 'say', say: 'task' }));
    writeTask(home, 'saoudrizwan.claude-dev', 'metadata-only', [
      null,
      42,
      {},
      { type: 'say', say: 'api_req_started', text: '{"tokensIn":1}' },
      { type: 'say', say: 'command_output', text: 'metadata noise' },
    ]);
    writeTask(home, 'saoudrizwan.claude-dev', 'valid-task', [
      null,
      { type: 'say', say: 'text', text: { nested: 'not text' } },
      { ts: 1770000100000, type: 'say', say: 'task', text: 'Keep this valid task' },
    ]);

    const { parseClineSessions } = await loadClineParser(home);
    const sessions = await parseClineSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'valid-task',
      summary: 'Keep this valid task',
    });
  });

  it('extracts shared context without duplicating streaming partials or fabricating tool summaries', async () => {
    const home = makeHome();
    const messages = [
      null,
      42,
      { ts: 1770000200000, type: 'say', say: 'task', text: 'Implement parser hardening' },
      { ts: 1770000201000, type: 'say', say: 'api_req_started', text: 'not json' },
      {
        ts: 1770000202000,
        type: 'say',
        say: 'api_req_started',
        text: '{"tokensIn":10,"tokensOut":0,"cacheWrites":2,"cacheReads":3,"cost":0.01}',
      },
      { ts: 1770000203000, type: 'say', say: 'text', text: 'Draft assistant answer', partial: true },
      { ts: 1770000204000, type: 'say', say: 'text', text: 'Final assistant answer', partial: false },
      { ts: 1770000205000, type: 'ask', ask: 'followup', text: 'Should I add parser tests?' },
      { ts: 1770000206000, type: 'say', say: 'user_feedback', text: 'Yes, add parser tests' },
      {
        ts: 1770000207000,
        type: 'say',
        say: 'reasoning',
        reasoning: 'Need to cover malformed messages, streaming finalization, and all source variants.',
      },
      {
        ts: 1770000208000,
        type: 'say',
        say: 'api_req_finished',
        text: '{"totalTokensIn":7,"totalTokensOut":8,"totalCacheWrites":1,"totalCacheReads":4,"totalCost":0.02}',
      },
      {
        ts: 1770000209000,
        type: 'ask',
        ask: 'completion_result',
        text: 'Done with parser hardening.\n- [ ] Run manual release check\nNext step: inspect handoff output',
      },
      { ts: 1770000210000, type: 'say', say: 'command_output', text: 'metadata noise' },
      { ts: 1770000211000, type: 'ask', ask: 'command', text: 'npm test' },
      { ts: 1770000212000, type: 'say', say: 'text', text: { nested: 'not text' } },
    ];
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'context-task', messages);

    const { extractClineContext, extractRooCodeContext, extractKiloCodeContext } = await loadClineParser(home);
    const extractors = [
      ['cline', extractClineContext],
      ['roo-code', extractRooCodeContext],
      ['kilo-code', extractKiloCodeContext],
    ] as const;

    for (const [source, extractContext] of extractors) {
      const context = await extractContext(sessionFor(source, originalPath));
      const contents = context.recentMessages.map((message) => message.content);

      expect(context.recentMessages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'assistant',
        'user',
        'assistant',
        'assistant',
      ]);
      expect(contents).toEqual([
        'Implement parser hardening',
        'Final assistant answer',
        'Should I add parser tests?',
        'Yes, add parser tests',
        'Need to cover malformed messages, streaming finalization, and all source variants.',
        'Done with parser hardening.\n- [ ] Run manual release check\nNext step: inspect handoff output',
      ]);
      expect(contents).not.toContain('Draft assistant answer');
      expect(contents).not.toContain('metadata noise');
      expect(contents).not.toContain('npm test');
      // Only `api_req_started` events carry per-request deltas;
      // `api_req_finished` carries running cumulative totals, so summing both
      // would double count. The malformed `api_req_started` ('not json') is
      // skipped, leaving the single valid event at ts=1770000202000.
      expect(context.sessionNotes?.tokenUsage).toEqual({ input: 10, output: 0 });
      expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 2, read: 3 });
      expect(context.sessionNotes?.reasoning).toEqual([
        'Need to cover malformed messages, streaming finalization, and all source variants.',
      ]);
      expect(context.pendingTasks).toEqual(['- [ ] Run manual release check', 'Next step: inspect handoff output']);
      expect(context.filesModified).toEqual([]);
      expect(context.toolSummaries).toEqual([]);
    }
  });

  it('extracts exact Cline tool activity from api_conversation_history.json', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'api-tool-task', [
      { ts: 1770000300000, type: 'say', say: 'task', text: 'Use exact API history tool calls' },
      { ts: 1770000301000, type: 'say', say: 'text', text: 'I will run tests and edit the parser.', partial: false },
    ]);
    writeCompanion(originalPath, 'api_conversation_history.json', [
      {
        role: 'user',
        ts: 1770000300000,
        content: [
          {
            type: 'text',
            text: 'Use exact API history tool calls\n<environment_details>\n# Current Working Directory (/tmp/cline-api-project) Files\n</environment_details>',
          },
        ],
      },
      {
        role: 'assistant',
        ts: 1770000301000,
        modelInfo: { modelId: 'claude-sonnet-4-20260229', providerId: 'anthropic', mode: 'act' },
        metrics: { tokens: { prompt: 100, completion: 20, cached: 30 }, cost: 0.02 },
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'execute_command', input: { command: 'pnpm test' } },
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'replace_in_file',
            input: { path: 'src/parsers/cline.ts', old_string: 'old', new_string: 'new' },
          },
        ],
      },
      {
        role: 'user',
        ts: 1770000302000,
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'Tests passed' },
          { type: 'tool_result', tool_use_id: 'tool-2', content: [{ type: 'text', text: 'Replaced 1 occurrence' }] },
        ],
      },
    ]);

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'api-tool-task'));
    const toolNames = context.toolSummaries.map((summary) => summary.name).sort();

    expect(toolNames).toEqual(['execute_command', 'replace_in_file']);
    expect(context.toolSummaries.find((summary) => summary.name === 'execute_command')?.samples[0].summary).toContain(
      'pnpm test',
    );
    expect(context.toolSummaries.find((summary) => summary.name === 'execute_command')?.samples[0].summary).toContain(
      'Tests passed',
    );
    expect(context.toolSummaries.find((summary) => summary.name === 'replace_in_file')?.samples[0].summary).toContain(
      'src/parsers/cline.ts',
    );
    expect(context.filesModified).toEqual(['src/parsers/cline.ts']);
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 100, output: 20 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 0, read: 30 });
  });

  it('recovers Cline cwd, model, and usage from task metadata and state task history without double counting', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'metadata-task', [
      { ts: 1770000400000, type: 'say', say: 'task', text: 'Recover metadata fields' },
      {
        ts: 1770000401000,
        type: 'say',
        say: 'api_req_finished',
        text: '{"totalTokensIn":999,"totalTokensOut":999,"totalCacheWrites":999,"totalCacheReads":999}',
      },
      { ts: 1770000402000, type: 'say', say: 'text', text: 'Metadata recovered.', partial: false },
    ]);
    writeCompanion(originalPath, 'task_metadata.json', {
      files_in_context: [],
      model_usage: [
        { ts: 1770000401500, model_id: 'claude-4-opus-metadata', model_provider_id: 'anthropic', mode: 'act' },
      ],
      environment_history: [],
    });
    writeTaskHistory(originalPath, [
      {
        id: 'metadata-task',
        ts: 1770000403000,
        task: 'Recover metadata fields',
        tokensIn: 123,
        tokensOut: 45,
        cacheWrites: 6,
        cacheReads: 7,
        totalCost: 0.03,
        cwdOnTaskInitialization: '/Users/tester/projects/cline-hardening',
        modelId: 'history-model-should-not-win',
      },
    ]);

    const { parseClineSessions, extractClineContext } = await loadClineParser(home);
    const sessions = await parseClineSessions();
    const session = sessions.find((item) => item.id === 'metadata-task');

    expect(session).toMatchObject({
      cwd: '/Users/tester/projects/cline-hardening',
      repo: 'projects/cline-hardening',
      model: 'claude-4-opus-metadata',
    });

    const context = await extractClineContext(session!);

    expect(context.session).toMatchObject({
      cwd: '/Users/tester/projects/cline-hardening',
      repo: 'projects/cline-hardening',
      model: 'claude-4-opus-metadata',
    });
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 123, output: 45 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 6, read: 7 });
  });

  it('loads shared task history once per storage root while listing sessions', async () => {
    const home = makeHome();
    const firstPath = writeTask(home, 'saoudrizwan.claude-dev', 'history-cache-a', [
      { ts: 1770000450000, type: 'say', say: 'task', text: 'Cache task history for first task' },
    ]);
    writeTask(home, 'saoudrizwan.claude-dev', 'history-cache-b', [
      { ts: 1770000451000, type: 'say', say: 'task', text: 'Cache task history for second task' },
    ]);
    writeTaskHistory(firstPath, [
      {
        id: 'history-cache-a',
        ts: 1770000452000,
        cwdOnTaskInitialization: '/tmp/history-cache-a',
        modelId: 'history-model-a',
      },
      {
        id: 'history-cache-b',
        ts: 1770000453000,
        cwdOnTaskInitialization: '/tmp/history-cache-b',
        modelId: 'history-model-b',
      },
    ]);
    const taskHistoryReads: string[] = [];

    const { parseClineSessions } = await loadClineParser(home, {
      onReadFile: (filePath) => {
        if (path.basename(filePath) === 'taskHistory.json') taskHistoryReads.push(filePath);
      },
    });
    const sessions = await parseClineSessions();

    expect(sessions.map((session) => session.id).sort()).toEqual(['history-cache-a', 'history-cache-b']);
    expect(sessions.find((session) => session.id === 'history-cache-a')).toMatchObject({
      cwd: '/tmp/history-cache-a',
      model: 'history-model-a',
    });
    expect(sessions.find((session) => session.id === 'history-cache-b')).toMatchObject({
      cwd: '/tmp/history-cache-b',
      model: 'history-model-b',
    });
    expect(taskHistoryReads).toHaveLength(1);
  });

  it('extracts cwd from request strings inside UI API metadata', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'request-string-cwd', [
      { ts: 1770000460000, type: 'say', say: 'task', text: 'Recover cwd from request metadata' },
      {
        ts: 1770000461000,
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({
          request: 'Current Working Directory (/tmp/request-string-project) Files\nsrc/parsers/cline.ts',
        }),
      },
    ]);

    const { parseClineSessions, extractClineContext } = await loadClineParser(home);
    const sessions = await parseClineSessions();
    const session = sessions.find((item) => item.id === 'request-string-cwd');

    expect(session).toMatchObject({
      cwd: '/tmp/request-string-project',
      repo: 'tmp/request-string-project',
    });

    const context = await extractClineContext(sessionFor('cline', originalPath, 'request-string-cwd'));

    expect(context.session).toMatchObject({
      cwd: '/tmp/request-string-project',
      repo: 'tmp/request-string-project',
    });
  });

  it('recovers context from API history and metadata when ui_messages.json is malformed', async () => {
    const home = makeHome();
    const originalPath = writeRawTask(home, 'saoudrizwan.claude-dev', 'malformed-ui-fallback', '{not valid json');
    writeCompanion(originalPath, 'task_metadata.json', {
      files_in_context: [],
      model_usage: [
        { ts: 1770000501000, model_id: 'claude-api-fallback-model', model_provider_id: 'anthropic', mode: 'act' },
      ],
      environment_history: [],
    });
    writeCompanion(originalPath, 'api_conversation_history.json', [
      {
        role: 'user',
        ts: 1770000500000,
        content: [
          {
            type: 'text',
            text: 'Recover this malformed UI task\n<environment_details>\nCurrent Working Directory: /tmp/fallback-project\n</environment_details>',
          },
        ],
      },
      {
        role: 'assistant',
        ts: 1770000501000,
        metrics: { tokens: { prompt: 12, completion: 8, cached: 3 } },
        content: [
          {
            type: 'text',
            text: 'Recovered from API history.\n- [ ] Re-run the parser test\nNext step: verify handoff output',
          },
        ],
      },
    ]);

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'malformed-ui-fallback'));

    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Recover this malformed UI task',
      'Recovered from API history.\n- [ ] Re-run the parser test\nNext step: verify handoff output',
    ]);
    expect(context.pendingTasks).toEqual(['- [ ] Re-run the parser test', 'Next step: verify handoff output']);
    expect(context.session).toMatchObject({
      cwd: '/tmp/fallback-project',
      repo: 'tmp/fallback-project',
      model: 'claude-api-fallback-model',
    });
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 12, output: 8 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 0, read: 3 });
  });

  it('returns empty context with a fidelity warning for invalid or non-array ui_messages.json files', async () => {
    const home = makeHome();
    const invalidPath = writeRawTask(home, 'saoudrizwan.claude-dev', 'invalid-context', '{not valid json');
    const nonArrayPath = writeRawTask(
      home,
      'saoudrizwan.claude-dev',
      'non-array-context',
      JSON.stringify({ ok: true }),
    );

    const { extractClineContext } = await loadClineParser(home);

    const invalidContext = await extractClineContext(sessionFor('cline', invalidPath));
    expect(invalidContext.recentMessages).toEqual([]);
    expect(invalidContext.pendingTasks).toEqual([]);
    expect(invalidContext.filesModified).toEqual([]);
    expect(invalidContext.toolSummaries).toEqual([]);
    expect(invalidContext.sessionNotes?.fidelityWarnings).toEqual([
      'ui_messages.json could not be parsed (invalid JSON)',
    ]);

    const nonArrayContext = await extractClineContext(sessionFor('cline', nonArrayPath));
    expect(nonArrayContext.recentMessages).toEqual([]);
    expect(nonArrayContext.pendingTasks).toEqual([]);
    expect(nonArrayContext.filesModified).toEqual([]);
    expect(nonArrayContext.toolSummaries).toEqual([]);
    expect(nonArrayContext.sessionNotes?.fidelityWarnings).toEqual([
      'ui_messages.json had unexpected shape (expected JSON array)',
    ]);
  });

  it('discovers Cline tasks from JetBrains globalStorage directories', async () => {
    const home = makeHome();
    // Simulate a JetBrains IDE storing its globalStorage at depth 3 below the
    // JetBrains config root (e.g. JetBrains/IntelliJIdea2025.1/options/.../globalStorage).
    const jbRoot = jetBrainsRoot(home);
    const jbStorage = path.join(jbRoot, 'IntelliJIdea2026.1', 'options', 'globalStorage');
    const jbTasksRoot = path.join(jbStorage, 'saoudrizwan.claude-dev', 'tasks');
    writeTaskAtRoot(jbTasksRoot, 'jetbrains-task', [
      { ts: 1770000700000, type: 'say', say: 'task', text: 'Discover from JetBrains globalStorage' },
    ]);

    const { parseClineSessions } = await loadClineParser(home);
    const sessions = await parseClineSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'jetbrains-task',
      source: 'cline',
      summary: 'Discover from JetBrains globalStorage',
    });
    expect(sessions[0].originalPath).toContain(path.join('JetBrains'));
  });

  it('does not infer cwd from bare path-like strings in API request metadata', async () => {
    const home = makeHome();
    // No `cwd` / `currentWorkingDirectory` key, no "Current Working Directory"
    // marker — only an unrelated path embedded in conversation text. The
    // previous accept-any-path heuristic would mis-classify `/usr/bin/node`
    // as the working directory; the constrained version must reject it.
    writeTask(home, 'saoudrizwan.claude-dev', 'no-cwd-task', [
      { ts: 1770000800000, type: 'say', say: 'task', text: 'No cwd marker anywhere' },
      {
        ts: 1770000801000,
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({
          request: 'The user mentioned /usr/bin/node and /etc/hosts in conversation.',
        }),
      },
    ]);

    const { parseClineSessions } = await loadClineParser(home);
    const sessions = await parseClineSessions();
    const session = sessions.find((item) => item.id === 'no-cwd-task');

    expect(session).toBeDefined();
    expect(session?.cwd).toBe('');
    expect(session?.repo).toBeUndefined();
  });

  it('normalizes Windows-style cwd separators when deriving repo', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'windows-cwd', [
      { ts: 1770000900000, type: 'say', say: 'task', text: 'Recover Windows cwd from task history' },
    ]);
    writeTaskHistory(originalPath, [
      {
        id: 'windows-cwd',
        ts: 1770000901000,
        cwdOnTaskInitialization: 'C:\\Users\\dev\\projects\\cli-continues',
      },
    ]);

    const { parseClineSessions } = await loadClineParser(home);
    const session = (await parseClineSessions()).find((item) => item.id === 'windows-cwd');

    expect(session).toMatchObject({
      cwd: 'C:/Users/dev/projects/cli-continues',
      repo: 'projects/cli-continues',
    });
  });

  // ── IDE-fork storage discovery ──────────────────────────────────────────

  it('discovers Cline tasks installed inside Cursor and Windsurf VS Code forks', async () => {
    const home = makeHome();
    // Cursor fork
    writeTaskAtRoot(path.join(ideGlobalStorageBase(home, 'Cursor'), 'saoudrizwan.claude-dev', 'tasks'), 'cursor-task', [
      { ts: 1770001000000, type: 'say', say: 'task', text: 'Discover from Cursor fork storage' },
    ]);
    // Windsurf fork
    writeTaskAtRoot(
      path.join(ideGlobalStorageBase(home, 'Windsurf'), 'saoudrizwan.claude-dev', 'tasks'),
      'windsurf-task',
      [{ ts: 1770001001000, type: 'say', say: 'task', text: 'Discover from Windsurf fork storage' }],
    );
    // Code Insiders fork (covers the third VS Code variant the parser scans)
    writeTaskAtRoot(
      path.join(ideGlobalStorageBase(home, 'Code - Insiders'), 'saoudrizwan.claude-dev', 'tasks'),
      'insiders-task',
      [{ ts: 1770001002000, type: 'say', say: 'task', text: 'Discover from VS Code Insiders' }],
    );

    const { parseClineSessions } = await loadClineParser(home);
    const sessions = await parseClineSessions();

    const ids = sessions.map((session) => session.id).sort();
    expect(ids).toEqual(['cursor-task', 'insiders-task', 'windsurf-task']);
    expect(sessions.every((session) => session.source === 'cline')).toBe(true);

    const cursor = sessions.find((session) => session.id === 'cursor-task');
    const windsurf = sessions.find((session) => session.id === 'windsurf-task');
    const insiders = sessions.find((session) => session.id === 'insiders-task');
    expect(cursor?.originalPath).toContain(path.join('Cursor'));
    expect(windsurf?.originalPath).toContain(path.join('Windsurf'));
    expect(insiders?.originalPath).toContain(path.join('Code - Insiders'));
  });

  it('does not duplicate tasks when the same task id exists across multiple IDE forks', async () => {
    const home = makeHome();
    // Same task id present in three forks with different summaries — each
    // fork has its own globalStorage so the parser must surface all three
    // distinct (storage-root, task-id) pairs, NOT collapse them. This is
    // the ONLY surface where Cline tasks "appear" twice on disk; users who
    // copied their saoudrizwan.claude-dev folder between IDE forks would
    // legitimately see the same id in each fork.
    writeTaskAtRoot(path.join(ideGlobalStorageBase(home, 'Code'), 'saoudrizwan.claude-dev', 'tasks'), 'shared-id', [
      { ts: 1770001100000, type: 'say', say: 'task', text: 'task in VS Code' },
    ]);
    writeTaskAtRoot(path.join(ideGlobalStorageBase(home, 'Cursor'), 'saoudrizwan.claude-dev', 'tasks'), 'shared-id', [
      { ts: 1770001101000, type: 'say', say: 'task', text: 'task in Cursor' },
    ]);
    writeTaskAtRoot(path.join(ideGlobalStorageBase(home, 'Windsurf'), 'saoudrizwan.claude-dev', 'tasks'), 'shared-id', [
      { ts: 1770001102000, type: 'say', say: 'task', text: 'task in Windsurf' },
    ]);

    const { parseClineSessions } = await loadClineParser(home);
    const sessions = await parseClineSessions();
    const sharedSessions = sessions.filter((session) => session.id === 'shared-id');

    expect(sharedSessions).toHaveLength(3);
    const summaries = sharedSessions.map((session) => session.summary).sort();
    expect(summaries).toEqual(['task in Cursor', 'task in VS Code', 'task in Windsurf']);
    // originalPath includes the IDE folder name so resume can reach the
    // right disk task even when ids collide.
    const ides = sharedSessions
      .map((session) => {
        if (session.originalPath.includes(path.join('Cursor'))) return 'Cursor';
        if (session.originalPath.includes(path.join('Windsurf'))) return 'Windsurf';
        return 'Code';
      })
      .sort();
    expect(ides).toEqual(['Code', 'Cursor', 'Windsurf']);
  });

  it('returns an empty list silently when no JetBrains plugin storage exists', async () => {
    // Even with the JetBrains config root absent (no IDE installed), the
    // parser must not throw or log an error path during discovery — it
    // should just return zero sessions across all sources.
    const home = makeHome();
    expect(fs.existsSync(jetBrainsRoot(home))).toBe(false);

    const { parseClineSessions, parseRooCodeSessions, parseKiloCodeSessions } = await loadClineParser(home);
    expect(await parseClineSessions()).toEqual([]);
    expect(await parseRooCodeSessions()).toEqual([]);
    expect(await parseKiloCodeSessions()).toEqual([]);
  });

  // ── Per-tool summary categorization ─────────────────────────────────────

  it('categorizes Cline read/write/search/list/MCP tool calls into structured summaries', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'tool-categories', [
      { ts: 1770001200000, type: 'say', say: 'task', text: 'Exercise every tool category' },
    ]);
    writeCompanion(originalPath, 'api_conversation_history.json', [
      {
        role: 'user',
        ts: 1770001200000,
        content: [{ type: 'text', text: 'run all tools' }],
      },
      {
        role: 'assistant',
        ts: 1770001201000,
        content: [
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/index.ts' } },
          { type: 'tool_use', id: 't2', name: 'write_to_file', input: { path: 'src/new.ts', content: 'hi' } },
          { type: 'tool_use', id: 't3', name: 'search_files', input: { regex: 'TODO', path: 'src' } },
          { type: 'tool_use', id: 't4', name: 'list_files', input: { path: 'src', recursive: true } },
          { type: 'tool_use', id: 't5', name: 'list_code_definition_names', input: { path: 'src/parsers' } },
          {
            type: 'tool_use',
            id: 't6',
            name: 'use_mcp_tool',
            input: { server_name: 'github', tool_name: 'list_issues', arguments: { repo: 'cline/cline' } },
          },
          { type: 'tool_use', id: 't7', name: 'apply_diff', input: { path: 'src/edit.ts', diff: 'patch' } },
        ],
      },
      {
        role: 'user',
        ts: 1770001202000,
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
          { type: 'tool_result', tool_use_id: 't2', content: 'wrote 1 file' },
          { type: 'tool_result', tool_use_id: 't3', content: 'no TODOs' },
          { type: 'tool_result', tool_use_id: 't4', content: '12 files' },
          { type: 'tool_result', tool_use_id: 't5', content: 'parsers/* defs' },
          { type: 'tool_result', tool_use_id: 't6', content: '0 issues' },
          { type: 'tool_result', tool_use_id: 't7', content: '+1 -0 lines' },
        ],
      },
    ]);

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'tool-categories'));
    const summariesByName = new Map(context.toolSummaries.map((summary) => [summary.name, summary]));

    expect(summariesByName.get('read_file')?.samples[0].data?.category).toBe('read');
    expect(summariesByName.get('read_file')?.samples[0].summary).toContain('src/index.ts');

    expect(summariesByName.get('write_to_file')?.samples[0].data?.category).toBe('write');
    expect(summariesByName.get('write_to_file')?.samples[0].summary).toContain('src/new.ts');

    expect(summariesByName.get('search_files')?.samples[0].data?.category).toBe('grep');
    expect(summariesByName.get('search_files')?.samples[0].summary).toContain('TODO');

    expect(summariesByName.get('list_files')?.samples[0].data?.category).toBe('glob');
    expect(summariesByName.get('list_code_definition_names')?.samples[0].data?.category).toBe('glob');

    // apply_diff is a known edit verb in the parser — same category as replace_in_file.
    expect(summariesByName.get('apply_diff')?.samples[0].data?.category).toBe('edit');
    expect(summariesByName.get('apply_diff')?.samples[0].summary).toContain('src/edit.ts');

    // Unknown / MCP-style tools fall through to the mcp category so handoff
    // markdown can still describe them generically.
    expect(summariesByName.get('use_mcp_tool')?.samples[0].data?.category).toBe('mcp');

    // write_to_file and apply_diff both report file modifications.
    expect([...context.filesModified].sort()).toEqual(['src/edit.ts', 'src/new.ts']);
  });

  // ── Token aggregation across canonical UI events ────────────────────────

  it('sums per-event token usage across api_req_started, deleted_api_reqs, and subagent_usage', async () => {
    // Mirrors upstream `getApiMetrics` (src/shared/getApiMetrics.ts): three
    // canonical event kinds carry per-request token deltas. Earlier
    // versions of the parser skipped `deleted_api_reqs` and
    // `subagent_usage`, undercounting tasks that condensed history or
    // used subagents.
    const home = makeHome();
    const originalPath = writeRawTask(home, 'saoudrizwan.claude-dev', 'usage-events', '');
    fs.writeFileSync(
      originalPath,
      JSON.stringify([
        { ts: 1770001300000, type: 'say', say: 'task', text: 'Aggregate every usage event' },
        {
          ts: 1770001301000,
          type: 'say',
          say: 'api_req_started',
          text: JSON.stringify({ tokensIn: 100, tokensOut: 50, cacheWrites: 5, cacheReads: 10 }),
        },
        {
          ts: 1770001302000,
          type: 'say',
          say: 'deleted_api_reqs',
          text: JSON.stringify({ tokensIn: 200, tokensOut: 80, cacheWrites: 0, cacheReads: 20 }),
        },
        {
          ts: 1770001303000,
          type: 'say',
          say: 'subagent_usage',
          text: JSON.stringify({ tokensIn: 300, tokensOut: 120, cacheWrites: 10, cacheReads: 30 }),
        },
        // Unrelated event kinds carrying token-shaped JSON must NOT be summed.
        {
          ts: 1770001304000,
          type: 'say',
          say: 'api_req_finished',
          text: JSON.stringify({ tokensIn: 999, tokensOut: 999, cacheWrites: 999, cacheReads: 999 }),
        },
      ]),
      'utf8',
    );

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'usage-events'));

    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 600, output: 250 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 15, read: 60 });
  });

  // ── Pending tasks from API history ──────────────────────────────────────

  it('extracts pending tasks from the last assistant message in api_conversation_history.json', async () => {
    // ui_messages.json has nothing pending; the parser must fall back to
    // walking the API conversation backwards to find the last assistant
    // message and pull TODO/Next-step lines.
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'api-pending', [
      { ts: 1770001400000, type: 'say', say: 'task', text: 'Recover pending from API history' },
    ]);
    writeCompanion(originalPath, 'api_conversation_history.json', [
      { role: 'user', ts: 1770001400000, content: [{ type: 'text', text: 'do work' }] },
      {
        role: 'assistant',
        ts: 1770001401000,
        content: [{ type: 'text', text: 'Almost done.\n- [ ] Review the diff\nNext step: open the PR' }],
      },
    ]);

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'api-pending'));

    expect(context.pendingTasks).toEqual(['- [ ] Review the diff', 'Next step: open the PR']);
  });

  // ── <environment_details> handling ──────────────────────────────────────

  it('strips well-formed environment_details and tolerates missing close tags', async () => {
    // Drive the test through API history (where the stripper actually runs
    // on user messages) by leaving ui_messages.json malformed so
    // `allConversation` falls back to apiConversation in extractContextShared.
    const home = makeHome();
    const originalPath = writeRawTask(home, 'saoudrizwan.claude-dev', 'env-details', '{not json');
    writeCompanion(originalPath, 'api_conversation_history.json', [
      {
        role: 'user',
        ts: 1770001500000,
        content: [
          {
            type: 'text',
            text: 'work please<environment_details>\n# Current Working Directory (/tmp/closed) Files\n</environment_details>',
          },
        ],
      },
      {
        role: 'assistant',
        ts: 1770001501000,
        content: [{ type: 'text', text: 'on it' }],
      },
      {
        role: 'user',
        ts: 1770001502000,
        // Malformed: the closing tag is missing. Stripper must NOT swallow
        // the message — the regex is non-greedy and anchored on a real
        // closing tag, so the content is kept verbatim.
        content: [{ type: 'text', text: 'follow up<environment_details>\nnever closed' }],
      },
    ]);

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'env-details'));
    const userTexts = context.recentMessages.filter((m) => m.role === 'user').map((m) => m.content);

    // First user turn: the well-formed env-details block is removed
    // (leaving only "work please"). Second user turn keeps the malformed
    // tag verbatim because there's nothing for the stripper to match.
    expect(userTexts).toContain('work please');
    expect(userTexts.some((text) => text.includes('never closed'))).toBe(true);
    expect(userTexts.every((text) => !text.includes('Current Working Directory'))).toBe(true);
  });

  // ── Companion-file fidelity warnings ────────────────────────────────────

  it('flags an unparseable api_conversation_history.json as a fidelity warning', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'api-broken', [
      { ts: 1770001600000, type: 'say', say: 'task', text: 'API history is broken' },
    ]);
    fs.writeFileSync(path.join(taskDirFor(originalPath), 'api_conversation_history.json'), '{not json', 'utf8');

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'api-broken'));

    expect(context.sessionNotes?.fidelityWarnings).toEqual([
      'api_conversation_history.json could not be parsed (invalid JSON)',
    ]);
  });

  it('flags an unparseable task_metadata.json as a fidelity warning', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'metadata-broken', [
      { ts: 1770001700000, type: 'say', say: 'task', text: 'Metadata is broken' },
    ]);
    fs.writeFileSync(path.join(taskDirFor(originalPath), 'task_metadata.json'), '{nope', 'utf8');

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'metadata-broken'));

    expect(context.sessionNotes?.fidelityWarnings).toContain('task_metadata.json could not be parsed (invalid JSON)');
  });

  it('flags an unparseable taskHistory.json as a fidelity warning while still parsing the task', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'history-broken', [
      { ts: 1770001800000, type: 'say', say: 'task', text: 'History index is broken' },
    ]);
    const storageRoot = path.dirname(path.dirname(taskDirFor(originalPath)));
    fs.mkdirSync(path.join(storageRoot, 'state'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'state', 'taskHistory.json'), '{not history', 'utf8');

    const { extractClineContext, parseClineSessions } = await loadClineParser(home);
    const sessions = await parseClineSessions();

    expect(sessions.find((session) => session.id === 'history-broken')).toBeDefined();
    const context = await extractClineContext(sessionFor('cline', originalPath, 'history-broken'));
    expect(context.sessionNotes?.fidelityWarnings).toContain('taskHistory.json could not be parsed (invalid JSON)');
  });

  // ── taskHistory.json edge cases ─────────────────────────────────────────

  it('gracefully handles taskHistory.json entries that do not match the current task id', async () => {
    // The shared taskHistory.json index can carry stale entries, but a
    // task-dir parse must only attach metadata for the matching id.
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'no-history-match', [
      { ts: 1770001900000, type: 'say', say: 'task', text: 'No matching history entry' },
    ]);
    writeTaskHistory(originalPath, [
      {
        id: 'some-other-task',
        ts: 1770001901000,
        cwdOnTaskInitialization: '/tmp/wrong-cwd',
        modelId: 'wrong-model',
        tokensIn: 9999,
        tokensOut: 9999,
      },
    ]);

    const { parseClineSessions, extractClineContext } = await loadClineParser(home);
    const sessions = await parseClineSessions();
    const session = sessions.find((item) => item.id === 'no-history-match');

    expect(session).toBeDefined();
    expect(session?.cwd).toBe('');
    expect(session?.model).toBeUndefined();

    const context = await extractClineContext(sessionFor('cline', originalPath, 'no-history-match'));
    expect(context.sessionNotes?.tokenUsage).toBeUndefined();
    expect(context.sessionNotes?.cacheTokens).toBeUndefined();
  });

  it('honors the latest model_usage entry in task_metadata.json over earlier ones', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'model-progression', [
      { ts: 1770002000000, type: 'say', say: 'task', text: 'Model progressed mid-task' },
    ]);
    writeCompanion(originalPath, 'task_metadata.json', {
      files_in_context: [],
      environment_history: [],
      model_usage: [
        { ts: 1770002001000, model_id: 'claude-3-7-sonnet', model_provider_id: 'anthropic', mode: 'plan' },
        { ts: 1770002002000, model_id: 'claude-4-opus', model_provider_id: 'anthropic', mode: 'act' },
        { ts: 1770002003000, model_id: 'claude-4-7-opus-final', model_provider_id: 'anthropic', mode: 'act' },
      ],
    });

    const { parseClineSessions, extractClineContext } = await loadClineParser(home);
    const session = (await parseClineSessions()).find((item) => item.id === 'model-progression');

    expect(session?.model).toBe('claude-4-7-opus-final');
    const context = await extractClineContext(session!);
    expect(context.session.model).toBe('claude-4-7-opus-final');
    expect(context.sessionNotes?.model).toBe('claude-4-7-opus-final');
  });

  it('opens Kilo SQLite databases read-only, rejecting any write attempt against the parser-opened handle', async () => {
    const home = makeHome();
    const dbPath = writeKiloDb(path.join(home, '.local', 'share', 'kilo'));

    // Open the same database the parser opens, with the same flags the parser uses.
    const sqliteModule = require('node:sqlite') as {
      DatabaseSync: new (database: string, options?: { open?: boolean; readOnly?: boolean }) => SqliteDatabase;
    };
    const handle = new sqliteModule.DatabaseSync(dbPath, { open: true, readOnly: true });
    try {
      // Every write path must throw under readOnly. node:sqlite's error message is
      // "attempt to write a readonly database" with code ERR_SQLITE_ERROR.
      expect(() =>
        handle
          .prepare(
            'INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run('ses_writes', 'proj_kilo', 'writes', '/tmp', 'should fail', '1', 0, 0),
      ).toThrow(/readonly|read-only|read only/i);
      expect(() => handle.exec("UPDATE session SET title = 'mutated' WHERE id = 'ses_kilo_db'")).toThrow(
        /readonly|read-only|read only/i,
      );
      expect(() => handle.exec("DELETE FROM session WHERE id = 'ses_kilo_db'")).toThrow(
        /readonly|read-only|read only/i,
      );
      expect(() => handle.exec('CREATE TABLE smoketest (x INTEGER)')).toThrow(/readonly|read-only|read only/i);
    } finally {
      handle.close();
    }

    // Confirm the parser's own handle, exercised end-to-end, doesn't mutate the file.
    const beforeStat = fs.statSync(dbPath);
    const beforeMtime = beforeStat.mtimeMs;
    const beforeSize = beforeStat.size;

    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();
    expect(sessions).toHaveLength(1);
    await extractKiloCodeContext(sessions[0]);

    const afterStat = fs.statSync(dbPath);
    expect(afterStat.size).toBe(beforeSize);
    // Allow filesystem mtime granularity but require no rewrite within the test.
    expect(afterStat.mtimeMs).toBe(beforeMtime);
  });

  it('summarizes extended Kilo part types (file, subtask, retry, tool error) as preview text without losing fidelity', async () => {
    const home = makeHome();
    const root = path.join(home, '.local', 'share', 'kilo');
    const dbPath = path.join(root, 'kilo.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openWritableSqlite(dbPath);
    const created = Date.parse('2026-04-17T10:00:00.000Z');
    const updated = Date.parse('2026-04-17T10:05:00.000Z');

    try {
      db.exec(`
        CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          directory TEXT NOT NULL,
          title TEXT NOT NULL,
          version TEXT NOT NULL,
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
      `);

      db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('proj_kilo_x', '/tmp/kilo-x');
      db.prepare(
        'INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        'ses_kilo_x',
        'proj_kilo_x',
        'kilo-extra-parts',
        '/tmp/kilo-x',
        'Mixed parts session',
        '7.2.0',
        created,
        updated,
      );

      // user message: text + file attachment
      db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(
        'msg_user_x',
        'ses_kilo_x',
        created,
        JSON.stringify({ role: 'user' }),
      );
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        'p_user_text',
        'msg_user_x',
        'ses_kilo_x',
        created,
        JSON.stringify({ type: 'text', text: 'Patch this attachment' }),
      );
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        'p_user_file',
        'msg_user_x',
        'ses_kilo_x',
        created + 1,
        JSON.stringify({
          type: 'file',
          mime: 'text/plain',
          filename: 'README.md',
          url: 'kilo://attachment/README.md',
        }),
      );

      // assistant message: tool error + subtask + retry + step-finish (which should be elided)
      db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)').run(
        'msg_asst_x',
        'ses_kilo_x',
        updated,
        JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-4' }),
      );
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        'p_asst_tool_err',
        'msg_asst_x',
        'ses_kilo_x',
        updated,
        JSON.stringify({
          type: 'tool',
          tool: 'edit_file',
          state: { status: 'error', input: { path: 'README.md' }, error: 'patch failed: hunk 2 rejected' },
        }),
      );
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        'p_asst_subtask',
        'msg_asst_x',
        'ses_kilo_x',
        updated + 1,
        JSON.stringify({
          type: 'subtask',
          agent: 'reviewer',
          description: 'Review the failing hunk and propose a corrected patch',
        }),
      );
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        'p_asst_retry',
        'msg_asst_x',
        'ses_kilo_x',
        updated + 2,
        JSON.stringify({ type: 'retry', attempt: 2, error: { message: 'rate limited', code: '429' } }),
      );
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        'p_asst_step_finish',
        'msg_asst_x',
        'ses_kilo_x',
        updated + 3,
        JSON.stringify({
          type: 'step-finish',
          reason: 'tool-calls',
          cost: 0.01,
          tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)').run(
        'p_asst_text',
        'msg_asst_x',
        'ses_kilo_x',
        updated + 4,
        JSON.stringify({ type: 'text', text: 'Retried successfully on attempt 3.' }),
      );
    } finally {
      db.close();
    }

    vi.stubEnv('KILO_DB', dbPath);
    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();
    const session = sessions.find((s) => s.id === 'ses_kilo_x') as UnifiedSession;
    expect(session).toBeDefined();
    const context = await extractKiloCodeContext(session);

    const userTurn = context.recentMessages.find((m) => m.role === 'user');
    expect(userTurn?.content).toContain('Patch this attachment');
    expect(userTurn?.content).toContain('[file]');
    expect(userTurn?.content).toContain('README.md');
    expect(userTurn?.content).toContain('text/plain');

    const assistantTurn = context.recentMessages.find((m) => m.role === 'assistant');
    expect(assistantTurn?.content).toMatch(/\[tool:edit_file:error\][\s\S]*patch failed/);
    expect(assistantTurn?.content).toContain('[subtask:reviewer]');
    expect(assistantTurn?.content).toContain('Review the failing hunk');
    expect(assistantTurn?.content).toContain('[retry:2]');
    expect(assistantTurn?.content).toContain('rate limited');
    expect(assistantTurn?.content).toContain('Retried successfully on attempt 3.');
    // step-finish must NOT bleed into conversation prose:
    expect(assistantTurn?.content).not.toMatch(/step-finish|tool-calls/);
  });

  it('parses legacy Kilo task folders with stale task_metadata.json companions defensively', async () => {
    const home = makeHome();
    // Write a legacy task folder, then pollute the same directory with a malformed
    // task_metadata.json so a future regression that begins reading it cannot crash.
    const filePath = writeTask(home, 'kilocode.kilo-code', 'kilo-companion-task', [
      { ts: 1770000400000, type: 'say', say: 'task', text: 'Survive companion metadata corruption' },
      { ts: 1770000401000, type: 'say', say: 'text', text: 'Final assistant answer' },
    ]);
    fs.writeFileSync(path.join(path.dirname(filePath), 'task_metadata.json'), '{ broken json', 'utf8');

    const { parseKiloCodeSessions, extractKiloCodeContext } = await loadClineParser(home);
    const sessions = await parseKiloCodeSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'kilo-companion-task',
      source: 'kilo-code',
      summary: 'Survive companion metadata corruption',
    });

    const context = await extractKiloCodeContext(sessions[0]);
    expect(context.recentMessages.map((m) => m.content)).toContain('Survive companion metadata corruption');
    expect(context.recentMessages.map((m) => m.content)).toContain('Final assistant answer');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevinFixture, type FixtureDir } from './fixtures/index.js';

const tmpDirs: string[] = [];
let fixture: FixtureDir | undefined;

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-parser-'));
  tmpDirs.push(dir);
  return dir;
}

async function loadDevinParser(
  home: string,
  options?: { envOverride?: boolean },
): Promise<typeof import('../parsers/devin.js')> {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  if (options?.envOverride !== false) {
    vi.stubEnv('DEVIN_CLI_HOME', path.join(home, '.local', 'share', 'devin', 'cli'));
  }
  return import('../parsers/devin.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
  fixture?.cleanup();
  fixture = undefined;
});

/** Copy the shared fixture DB into the given install channel directory. */
function installFixtureDb(home: string, channel: string, hidden = false): string {
  if (!fixture) fixture = createDevinFixture();
  const dbPath = path.join(fixture.root, 'sessions.db');
  const targetDir = path.join(home, '.local', 'share', 'devin', channel);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'sessions.db');
  fs.copyFileSync(dbPath, target);
  if (hidden) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(target);
    db.prepare('UPDATE sessions SET hidden = 1').run();
    db.close();
  }
  return target;
}

describe('devin parser', () => {
  it('discovers sessions from the cli install channel', async () => {
    const home = makeHome();
    installFixtureDb(home, 'cli');

    const { parseDevinSessions } = await loadDevinParser(home);
    const sessions = await parseDevinSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('test-devin-session-1');
    expect(sessions[0].source).toBe('devin');
    expect(sessions[0].cwd).toBe('/home/user/project');
    expect(sessions[0].repo).toBe('user/project');
    expect(sessions[0].summary).toBe('Fix auth bug');
    expect(sessions[0].model).toBe('claude-opus-4-6');
    expect(sessions[0].lines).toBe(8);
    // Unix-second timestamps are interpreted correctly.
    expect(sessions[0].updatedAt.toISOString()).toBe(new Date(1_734_000_040 * 1000).toISOString());
  });

  it('merges sessions from both install channels', async () => {
    const home = makeHome();
    installFixtureDb(home, 'cli');
    installFixtureDb(home, 'cli-next');

    const { parseDevinSessions } = await loadDevinParser(home, { envOverride: false });
    const sessions = await parseDevinSessions();

    expect(sessions).toHaveLength(2);
  });

  it('skips hidden sessions', async () => {
    const home = makeHome();
    installFixtureDb(home, 'cli', true);

    const { parseDevinSessions } = await loadDevinParser(home);
    const sessions = await parseDevinSessions();

    expect(sessions).toHaveLength(0);
  });

  it('falls back to the first user prompt when the title is generic', async () => {
    const home = makeHome();
    const dbPath = installFixtureDb(home, 'cli');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE sessions SET title = ?').run('');
    db.close();

    const { parseDevinSessions } = await loadDevinParser(home);
    const sessions = await parseDevinSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toContain('Fix the authentication bug');
  });

  it('extracts conversation, tool calls, and modified files from the main chain', async () => {
    const home = makeHome();
    const dbPath = installFixtureDb(home, 'cli');

    const { parseDevinSessions, extractDevinContext } = await loadDevinParser(home);
    const sessions = await parseDevinSessions();
    const context = await extractDevinContext(sessions[0]);

    const userMsgs = context.recentMessages.filter((m) => m.role === 'user');
    const asstMsgs = context.recentMessages.filter((m) => m.role === 'assistant');
    expect(userMsgs).toHaveLength(2);
    expect(asstMsgs).toHaveLength(3);
    expect(userMsgs[0].content).toContain('Fix the authentication bug');
    expect(asstMsgs[2].content).toContain('try-catch');

    // Tool calls are captured with their results paired in order.
    const readCall = asstMsgs[0].toolCalls?.[0];
    expect(readCall?.name).toBe('read');
    expect(readCall?.result).toContain('export function login()');

    const editCall = asstMsgs[1].toolCalls?.[0];
    expect(editCall?.name).toBe('edit');
    expect(editCall?.result).toContain('File edited successfully');

    // Tool activity summaries + file tracking.
    const summaryNames = context.toolSummaries.map((s) => s.name);
    expect(summaryNames).toContain('read');
    expect(summaryNames).toContain('edit');
    expect(context.filesModified).toContain('/home/user/project/login.ts');

    // Markdown handoff renders with the Devin label and raw access note.
    expect(context.markdown).toContain('Devin CLI');
    expect(context.sessionNotes?.rawAccess).toEqual({ kind: 'sqlite', path: dbPath });
  });

  it('returns an empty context when the database is missing', async () => {
    const home = makeHome();
    const { extractDevinContext } = await loadDevinParser(home);

    const context = await extractDevinContext({
      id: 'missing',
      source: 'devin',
      cwd: '/tmp',
      lines: 0,
      bytes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: path.join(home, 'does-not-exist.db'),
    });

    expect(context.recentMessages).toEqual([]);
    expect(context.sessionNotes?.fidelityWarnings).toHaveLength(1);
  });
});

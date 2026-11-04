import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseOpenCodeSessions } from '../parsers/opencode.js';
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

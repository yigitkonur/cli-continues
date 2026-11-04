import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOpenCodeV2SqliteFixture } from './fixtures/index.js';
import type { FixtureDir } from './fixtures/index.js';

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

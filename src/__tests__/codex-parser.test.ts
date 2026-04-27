import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

function makeCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parser-'));
  tempDirs.push(dir);
  return dir;
}

function writeRollout(root: string, subdir: string, filename: string, rows: unknown[]): string {
  const targetDir = path.join(root, subdir);
  fs.mkdirSync(targetDir, { recursive: true });
  const fullPath = path.join(targetDir, filename);
  fs.writeFileSync(fullPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return fullPath;
}

async function loadCodexParser(home: string): Promise<typeof import('../parsers/codex.js')> {
  vi.resetModules();
  vi.stubEnv('CODEX_HOME', home);
  return import('../parsers/codex.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('codex parser hardening', () => {
  it('discovers sessions from both active and archived session trees', async () => {
    const home = makeCodexHome();

    writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T10-00-00-active-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'active-session-id', cwd: '/tmp/active' },
        },
        {
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Active session' },
        },
      ],
    );

    writeRollout(
      home,
      path.join('archived_sessions', '2026', '04', '14'),
      'rollout-2026-04-14T09-00-00-archived-session-id.jsonl',
      [
        {
          timestamp: '2026-04-14T09:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'archived-session-id', cwd: '/tmp/archived' },
        },
        {
          timestamp: '2026-04-14T09:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Archived session' },
        },
      ],
    );

    const { parseCodexSessions } = await loadCodexParser(home);
    const sessions = await parseCodexSessions();

    expect(sessions.map((session) => session.id)).toContain('active-session-id');
    expect(sessions.map((session) => session.id)).toContain('archived-session-id');
  });

  it('extracts token usage from nested token_count payload.info totals', async () => {
    const home = makeCodexHome();
    const originalPath = writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T10-00-00-token-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'token-session-id',
            cwd: '/tmp/project',
            git: { branch: 'main', repository_url: 'https://github.com/user/project.git' },
          },
        },
        {
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Token check' }] },
        },
        {
          timestamp: '2026-04-15T10:00:02.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
        },
        {
          timestamp: '2026-04-15T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 120,
                output_tokens: 45,
                cached_input_tokens: 17,
                reasoning_output_tokens: 9,
              },
              last_token_usage: {
                input_tokens: 20,
                output_tokens: 5,
                cached_input_tokens: 2,
                reasoning_output_tokens: 1,
              },
            },
          },
        },
      ],
    );

    const { extractCodexContext } = await loadCodexParser(home);
    const session: UnifiedSession = {
      id: 'token-session-id',
      source: 'codex',
      cwd: '/tmp/project',
      repo: 'user/project',
      branch: 'main',
      lines: 4,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T10:00:03.000Z'),
      originalPath,
      summary: 'Token check',
    };

    const context = await extractCodexContext(session);

    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 120, output: 45 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 0, read: 17 });
    expect(context.sessionNotes?.thinkingTokens).toBe(9);
  });
});

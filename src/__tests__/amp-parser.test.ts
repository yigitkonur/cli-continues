import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeAmpFixture(): { root: string; xdgDataHome: string; threadPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amp-parser-'));
  tempDirs.push(root);
  const xdgDataHome = path.join(root, 'xdg-data');
  const threadsDir = path.join(xdgDataHome, 'amp', 'threads');
  const projectCwd = path.join(os.homedir(), 'amp-project');
  fs.mkdirSync(threadsDir, { recursive: true });
  const threadPath = path.join(threadsDir, 'thread-amp-battle.json');
  fs.writeFileSync(
    threadPath,
    JSON.stringify(
      {
        id: 'thread-amp-battle',
        title: 'Repair Amp parser',
        created: Date.parse('2026-04-15T10:00:00.000Z'),
        env: {
          initial: {
            tags: ['model:claude-opus-4-5'],
            installationID: 'inst-test-do-not-leak',
            deviceFingerprint: 'fp-test-do-not-leak',
            trees: [
              {
                uri: pathToFileURL(projectCwd).href,
                repository: {
                  url: 'https://github.com/user/amp-project.git',
                  ref: 'refs/heads/parser-fixes',
                  sha: 'abcdef1234567890',
                },
              },
            ],
          },
        },
        messages: [
          {
            role: 'user',
            messageId: 1,
            meta: { sentAt: Date.parse('2026-04-15T10:00:01.000Z') },
            content: [{ type: 'text', text: 'Fix Amp metadata extraction' }],
          },
          {
            role: 'assistant',
            messageId: 2,
            meta: { sentAt: Date.parse('2026-04-15T10:00:03.000Z') },
            content: [{ type: 'text', text: 'Amp metadata extraction is fixed.' }],
          },
        ],
        usageLedger: {
          events: [{ model: 'claude-opus-4-5', tokens: { input: 12, output: 8 } }],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return { root, xdgDataHome, threadPath };
}

async function loadAmpParser(xdgDataHome: string): Promise<typeof import('../parsers/amp.js')> {
  vi.resetModules();
  vi.stubEnv('XDG_DATA_HOME', xdgDataHome);
  return import('../parsers/amp.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('amp parser hardening', () => {
  it('extracts cwd, repo, branch, git SHA, and per-message timestamps from thread metadata', async () => {
    const fixture = makeAmpFixture();
    const { parseAmpSessions, extractAmpContext } = await loadAmpParser(fixture.xdgDataHome);

    const [session] = await parseAmpSessions();
    const context = await extractAmpContext(session);

    expect(session).toMatchObject({
      id: 'thread-amp-battle',
      cwd: path.join(os.homedir(), 'amp-project'),
      repo: 'user/amp-project',
      branch: 'parser-fixes',
      gitSha: 'abcdef1234567890',
      model: 'claude-opus-4-5',
    });
    expect(context.recentMessages.map((message) => message.timestamp?.toISOString())).toEqual([
      '2026-04-15T10:00:01.000Z',
      '2026-04-15T10:00:03.000Z',
    ]);
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 12, output: 8 });
    expect(context.markdown).toContain('~/amp-project');
    expect(context.markdown).not.toContain('installationID');
    expect(context.markdown).not.toContain('deviceFingerprint');
  });
});

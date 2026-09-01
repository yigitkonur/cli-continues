import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiFamilyParser } from '../parsers/pi-family.js';

const tmpDirs: string[] = [];

function makeAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-pi-family-'));
  tmpDirs.push(dir);
  return dir;
}

function writeSession(agentDir: string, rows: unknown[]): string {
  const filePath = path.join(agentDir, 'sessions', '--tmp-project--', 'session.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

function fixtureRows(): unknown[] {
  return [
    {
      type: 'session',
      version: 3,
      id: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-07-28T10:00:00.000Z',
      cwd: '/tmp/project',
    },
    {
      type: 'message',
      id: 'user0001',
      parentId: null,
      timestamp: '2026-07-28T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Add Pi support' }] },
    },
    {
      type: 'message',
      id: 'old00001',
      parentId: 'user0001',
      timestamp: '2026-07-28T10:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Abandoned branch' }] },
    },
    {
      type: 'message',
      id: 'tool0001',
      parentId: 'user0001',
      timestamp: '2026-07-28T10:00:03.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet',
        usage: { input: 12, output: 4 },
        content: [
          { type: 'text', text: 'Implementing it.' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'write',
            arguments: { path: '/tmp/project/pi.ts', content: 'export const pi = true;' },
          },
        ],
      },
    },
    {
      type: 'message',
      id: 'result01',
      parentId: 'tool0001',
      timestamp: '2026-07-28T10:00:04.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'write',
        content: [{ type: 'text', text: 'Created /tmp/project/pi.ts' }],
        isError: false,
      },
    },
    {
      type: 'session_info',
      id: 'info0001',
      parentId: 'result01',
      timestamp: '2026-07-28T10:00:05.000Z',
      name: 'Pi integration',
    },
  ];
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe.each(['pi', 'omp'] as const)('%s family parser', (source) => {
  it('discovers session metadata from the configured agent directory', async () => {
    const agentDir = makeAgentDir();
    writeSession(agentDir, fixtureRows());
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '');
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    const parser = createPiFamilyParser({ source, defaultAgentDir: agentDir });

    const [session] = await parser.parseSessions();

    expect(session).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      source,
      cwd: '/tmp/project',
      summary: 'Pi integration',
      model: 'claude-sonnet',
    });
  });

  it('ignores JSONL artifacts nested inside a session sidecar directory', async () => {
    const agentDir = makeAgentDir();
    const primaryPath = writeSession(agentDir, fixtureRows());
    const artifactPath = path.join(primaryPath.replace(/\.jsonl$/u, ''), 'handoff.jsonl');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(fixtureRows()[0])}\n`, 'utf8');
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '');
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    const parser = createPiFamilyParser({ source, defaultAgentDir: agentDir });

    const sessions = await parser.parseSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].originalPath).toBe(primaryPath);
  });
});

describe('Pi-family context extraction', () => {
  it('uses only the active branch and converts Pi toolCall records', async () => {
    const agentDir = makeAgentDir();
    writeSession(agentDir, fixtureRows());
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '');
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    const parser = createPiFamilyParser({ source: 'pi', defaultAgentDir: agentDir });
    const [session] = await parser.parseSessions();

    const context = await parser.extractContext(session);

    expect(context.recentMessages.map((message) => message.content)).toEqual(['Add Pi support', 'Implementing it.']);
    expect(context.filesModified).toEqual(['/tmp/project/pi.ts']);
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 12, output: 4 });
    expect(context.markdown).not.toContain('Abandoned branch');
  });
});

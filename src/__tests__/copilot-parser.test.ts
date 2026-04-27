import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tmpDirs: string[] = [];

function writeJsonl(filePath: string, rows: unknown[]): void {
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

function createCopilotSession(opts: {
  copilotHome: string;
  sessionId: string;
  workspace?: {
    cwd?: string;
    repository?: string;
    branch?: string;
    summary?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  events: unknown[];
}): string {
  const sessionDir = path.join(opts.copilotHome, 'session-state', opts.sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const workspace = [
    `id: ${opts.sessionId}`,
    `cwd: ${opts.workspace?.cwd ?? '/tmp/copilot-project'}`,
    `repository: ${opts.workspace?.repository ?? 'acme/copilot-project'}`,
    `branch: ${opts.workspace?.branch ?? 'main'}`,
    `summary: "${opts.workspace?.summary ?? 'Copilot parser regression'}"`,
    `created_at: ${opts.workspace?.createdAt ?? '2026-04-15T10:00:00.000Z'}`,
    `updated_at: ${opts.workspace?.updatedAt ?? '2026-04-15T10:05:00.000Z'}`,
  ].join('\n');

  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `${workspace}\n`, 'utf8');
  writeJsonl(path.join(sessionDir, 'events.jsonl'), opts.events);

  return sessionDir;
}

async function loadCopilotParserWithHome(homeDir: string): Promise<typeof import('../parsers/copilot.js')> {
  vi.resetModules();
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });
  return import('../parsers/copilot.js');
}

function makeSession(sessionDir: string, sessionId: string): UnifiedSession {
  const eventsPath = path.join(sessionDir, 'events.jsonl');
  const stats = fs.statSync(eventsPath);
  return {
    id: sessionId,
    source: 'copilot',
    cwd: '/tmp/copilot-project',
    repo: 'acme/copilot-project',
    branch: 'main',
    summary: 'Copilot parser regression',
    lines: fs.readFileSync(eventsPath, 'utf8').trim().split('\n').length,
    bytes: stats.size,
    createdAt: new Date('2026-04-15T10:00:00.000Z'),
    updatedAt: new Date('2026-04-15T10:05:00.000Z'),
    originalPath: sessionDir,
    model: 'claude-sonnet-4',
  };
}

afterEach(() => {
  vi.doUnmock('os');
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('copilot parser regressions', () => {
  it('discovers sessions from COPILOT_HOME instead of only ~/.copilot', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-config-'));
    tmpDirs.push(fakeHome, copilotHome);

    createCopilotSession({
      copilotHome,
      sessionId: 'copilot-home-session',
      events: [
        {
          type: 'session.start',
          id: 'evt-001',
          timestamp: '2026-04-15T10:00:00.000Z',
          parentId: null,
          data: {
            sessionId: 'copilot-home-session',
            selectedModel: 'claude-sonnet-4',
          },
        },
        {
          type: 'user.message',
          id: 'evt-002',
          timestamp: '2026-04-15T10:00:01.000Z',
          parentId: 'evt-001',
          data: {
            content: 'Honor COPILOT_HOME',
          },
        },
      ],
    });

    vi.stubEnv('COPILOT_HOME', copilotHome);
    const { parseCopilotSessions } = await loadCopilotParserWithHome(fakeHome);
    const sessions = await parseCopilotSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('copilot-home-session');
    expect(sessions[0].originalPath).toContain(copilotHome);
  });

  it('enriches tool summaries with tool.execution_complete results without double-counting matching assistant tool requests', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-config-'));
    tmpDirs.push(fakeHome, copilotHome);

    const sessionDir = createCopilotSession({
      copilotHome,
      sessionId: 'tool-result-session',
      events: [
        {
          type: 'session.start',
          id: 'evt-001',
          timestamp: '2026-04-15T10:00:00.000Z',
          parentId: null,
          data: {
            sessionId: 'tool-result-session',
            selectedModel: 'claude-sonnet-4',
          },
        },
        {
          type: 'user.message',
          id: 'evt-002',
          timestamp: '2026-04-15T10:00:01.000Z',
          parentId: 'evt-001',
          data: {
            content: 'Run the test suite',
          },
        },
        {
          type: 'assistant.message',
          id: 'evt-003',
          timestamp: '2026-04-15T10:00:02.000Z',
          parentId: 'evt-002',
          data: {
            content: 'Running the tests now.',
            toolRequests: [
              {
                name: 'bash',
                arguments: {
                  command: 'pnpm test --filter copilot',
                },
              },
            ],
          },
        },
        {
          type: 'tool.execution_start',
          id: 'evt-004',
          timestamp: '2026-04-15T10:00:03.000Z',
          parentId: 'evt-003',
          data: {
            toolCallId: 'tool-001',
            toolName: 'bash',
            arguments: {
              command: 'pnpm test --filter copilot',
            },
          },
        },
        {
          type: 'tool.execution_complete',
          id: 'evt-005',
          timestamp: '2026-04-15T10:00:04.000Z',
          parentId: 'evt-004',
          data: {
            toolCallId: 'tool-001',
            success: true,
            result: {
              content: '2 tests passed',
              detailedContent: '2 tests passed\n<exited with exit code 0>',
            },
          },
        },
      ],
    });

    const { extractCopilotContext } = await loadCopilotParserWithHome(fakeHome);
    const context = await extractCopilotContext(makeSession(sessionDir, 'tool-result-session'));
    const bashSummary = context.toolSummaries.find((summary) => summary.name === 'bash');

    expect(bashSummary).toBeDefined();
    expect(bashSummary?.count).toBe(1);
    expect(bashSummary?.samples[0].summary).toContain('2 tests passed');
    expect(bashSummary?.samples[0].data).toMatchObject({
      category: 'shell',
      command: 'pnpm test --filter copilot',
      exitCode: 0,
      stdoutTail: '2 tests passed',
    });
  });

  it('captures write activity from tool execution events even when assistant toolRequests are absent', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-config-'));
    tmpDirs.push(fakeHome, copilotHome);

    const sessionDir = createCopilotSession({
      copilotHome,
      sessionId: 'tool-write-session',
      events: [
        {
          type: 'session.start',
          id: 'evt-001',
          timestamp: '2026-04-15T10:00:00.000Z',
          parentId: null,
          data: {
            sessionId: 'tool-write-session',
            selectedModel: 'claude-sonnet-4',
          },
        },
        {
          type: 'user.message',
          id: 'evt-002',
          timestamp: '2026-04-15T10:00:01.000Z',
          parentId: 'evt-001',
          data: {
            content: 'Patch the Copilot parser',
          },
        },
        {
          type: 'assistant.message',
          id: 'evt-003',
          timestamp: '2026-04-15T10:00:02.000Z',
          parentId: 'evt-002',
          data: {
            content: 'Applying the parser fix.',
            toolRequests: [],
          },
        },
        {
          type: 'tool.execution_start',
          id: 'evt-004',
          timestamp: '2026-04-15T10:00:03.000Z',
          parentId: 'evt-003',
          data: {
            toolCallId: 'tool-002',
            toolName: 'WriteFile',
            arguments: {
              path: 'src/parsers/copilot.ts',
            },
          },
        },
        {
          type: 'tool.execution_complete',
          id: 'evt-005',
          timestamp: '2026-04-15T10:00:04.000Z',
          parentId: 'evt-004',
          data: {
            toolCallId: 'tool-002',
            success: true,
            result: {
              content: 'File updated successfully',
            },
          },
        },
      ],
    });

    const { extractCopilotContext } = await loadCopilotParserWithHome(fakeHome);
    const context = await extractCopilotContext(makeSession(sessionDir, 'tool-write-session'));
    const writeSummary = context.toolSummaries.find((summary) => summary.name === 'WriteFile');

    expect(writeSummary).toBeDefined();
    expect(writeSummary?.count).toBe(1);
    expect(context.filesModified).toContain('src/parsers/copilot.ts');
    expect(writeSummary?.samples[0].data).toMatchObject({
      category: 'write',
      filePath: 'src/parsers/copilot.ts',
    });
  });

  it('falls back to result.contents text blocks when tool.execution_complete omits content strings', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-config-'));
    tmpDirs.push(fakeHome, copilotHome);

    const sessionDir = createCopilotSession({
      copilotHome,
      sessionId: 'tool-contents-session',
      events: [
        {
          type: 'session.start',
          id: 'evt-001',
          timestamp: '2026-04-15T10:00:00.000Z',
          parentId: null,
          data: {
            sessionId: 'tool-contents-session',
            selectedModel: 'claude-sonnet-4',
          },
        },
        {
          type: 'user.message',
          id: 'evt-002',
          timestamp: '2026-04-15T10:00:01.000Z',
          parentId: 'evt-001',
          data: {
            content: 'Run a fallback-result shell command',
          },
        },
        {
          type: 'tool.execution_start',
          id: 'evt-003',
          timestamp: '2026-04-15T10:00:02.000Z',
          parentId: 'evt-002',
          data: {
            toolCallId: 'tool-003',
            toolName: 'bash',
            arguments: {
              command: 'git status --short',
            },
          },
        },
        {
          type: 'tool.execution_complete',
          id: 'evt-004',
          timestamp: '2026-04-15T10:00:03.000Z',
          parentId: 'evt-003',
          data: {
            toolCallId: 'tool-003',
            success: true,
            result: {
              contents: [
                {
                  type: 'text',
                  text: 'M src/parsers/copilot.ts\n<exited with exit code 0>',
                },
              ],
            },
          },
        },
      ],
    });

    const { extractCopilotContext } = await loadCopilotParserWithHome(fakeHome);
    const context = await extractCopilotContext(makeSession(sessionDir, 'tool-contents-session'));
    const bashSummary = context.toolSummaries.find((summary) => summary.name === 'bash');

    expect(bashSummary).toBeDefined();
    expect(bashSummary?.count).toBe(1);
    expect(bashSummary?.samples[0].summary).toContain('exit 0');
    expect(bashSummary?.samples[0].data).toMatchObject({
      category: 'shell',
      command: 'git status --short',
      exitCode: 0,
      stdoutTail: 'M src/parsers/copilot.ts\n<exited with exit code 0>',
    });
  });
});

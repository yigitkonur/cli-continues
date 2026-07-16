import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as OmpParser from '../parsers/omp.js';
import type { UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

function makeOmpAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-parser-'));
  tempDirs.push(dir);
  return dir;
}

function writeOmpSession(agentDir: string, projectSlug: string, filename: string, rows: unknown[]): string {
  const targetDir = path.join(agentDir, 'sessions', projectSlug);
  fs.mkdirSync(targetDir, { recursive: true });
  const fullPath = path.join(targetDir, filename);
  fs.writeFileSync(fullPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return fullPath;
}

async function loadOmpParser(agentDir: string): Promise<typeof OmpParser> {
  vi.resetModules();
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  return import('../parsers/omp.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('omp parser', () => {
  it('discovers Oh My Pi sessions from PI_CODING_AGENT_DIR project folders', async () => {
    const agentDir = makeOmpAgentDir();
    writeOmpSession(agentDir, '-tmp-project', '2026-07-16T10-38-55-184Z_019f6a82-test-session.jsonl', [
      {
        type: 'title',
        v: 1,
        title: 'Fix parser edge cases',
        source: 'auto',
        updatedAt: '2026-07-16T10:39:34.876Z',
      },
      {
        type: 'session',
        version: 3,
        id: '019f6a82-test-session',
        timestamp: '2026-07-16T10:38:55.184Z',
        cwd: '/tmp/project',
        title: 'Fix parser edge cases',
      },
      {
        type: 'model_change',
        id: 'model-1',
        parentId: null,
        timestamp: '2026-07-16T10:38:56.000Z',
        model: 'openai-codex/gpt-5.5',
      },
      {
        type: 'message',
        id: 'user-1',
        parentId: 'model-1',
        timestamp: '2026-07-16T10:39:08.530Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Please fix the parser.' }],
        },
      },
    ]);

    const { parseOmpSessions } = await loadOmpParser(agentDir);
    const sessions = await parseOmpSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: '019f6a82-test-session',
      source: 'omp',
      cwd: '/tmp/project',
      summary: 'Fix parser edge cases',
      model: 'openai-codex/gpt-5.5',
      originalPath: expect.stringContaining('2026-07-16T10-38-55-184Z_019f6a82-test-session.jsonl'),
    });
    expect(sessions[0]?.createdAt.toISOString()).toBe('2026-07-16T10:38:55.184Z');
    expect(sessions[0]?.updatedAt.toISOString()).toBe('2026-07-16T10:39:34.876Z');
  });

  it('keeps lightweight session ordering based on latest header metadata timestamp', async () => {
    const agentDir = makeOmpAgentDir();
    writeOmpSession(agentDir, '-tmp-project', '2026-07-16T10-00-00-000Z_older-created-active.jsonl', [
      {
        type: 'title',
        v: 1,
        title: 'Active OMP session',
        updatedAt: '2026-07-16T10:59:00.000Z',
      },
      {
        type: 'session',
        version: 3,
        id: 'older-created-active',
        timestamp: '2026-07-16T10:00:00.000Z',
        cwd: '/tmp/project',
        title: 'Active OMP session',
      },
    ]);
    writeOmpSession(agentDir, '-tmp-project', '2026-07-16T10-30-00-000Z_newer-created-stale.jsonl', [
      {
        type: 'title',
        v: 1,
        title: 'Stale OMP session',
        updatedAt: '2026-07-16T10:30:00.000Z',
      },
      {
        type: 'session',
        version: 3,
        id: 'newer-created-stale',
        timestamp: '2026-07-16T10:30:00.000Z',
        cwd: '/tmp/project',
        title: 'Stale OMP session',
      },
    ]);

    const { parseOmpSessions } = await loadOmpParser(agentDir);
    const sessions = await parseOmpSessions({ lightweight: true });

    expect(sessions.map((session) => session.id)).toEqual(['older-created-active', 'newer-created-stale']);
    expect(sessions[0]?.updatedAt.toISOString()).toBe('2026-07-16T10:59:00.000Z');
  });

  it('extracts OMP messages, tool activity, model notes, token usage, and lifecycle', async () => {
    const agentDir = makeOmpAgentDir();
    const originalPath = writeOmpSession(
      agentDir,
      '-tmp-project',
      '2026-07-16T10-38-55-184Z_019f6a82-context-session.jsonl',
      [
        {
          type: 'session',
          version: 3,
          id: '019f6a82-context-session',
          timestamp: '2026-07-16T10:38:55.184Z',
          cwd: '/tmp/project',
          title: 'Add OMP support',
        },
        {
          type: 'model_change',
          id: 'model-1',
          timestamp: '2026-07-16T10:38:55.255Z',
          model: 'openai-codex/gpt-5.5',
        },
        {
          type: 'thinking_level_change',
          id: 'thinking-1',
          parentId: 'model-1',
          timestamp: '2026-07-16T10:39:08.526Z',
          thinkingLevel: 'high',
          configured: 'auto',
        },
        {
          type: 'message',
          id: 'user-1',
          parentId: 'thinking-1',
          timestamp: '2026-07-16T10:39:08.530Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Add support for OMP sessions.' }],
          },
        },
        {
          type: 'message',
          id: 'assistant-1',
          parentId: 'user-1',
          timestamp: '2026-07-16T10:39:12.871Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '**Planning parser changes**' },
              {
                type: 'toolCall',
                id: 'call-read',
                name: 'read',
                arguments: { i: 'Reading package', path: 'package.json' },
              },
            ],
            provider: 'openai-codex',
            model: 'gpt-5.5',
            usage: {
              input: 100,
              output: 40,
              cacheRead: 12,
              cacheWrite: 3,
              reasoningTokens: 7,
            },
          },
        },
        {
          type: 'custom',
          customType: 'tool_execution_start',
          data: {
            toolCallId: 'call-read',
            toolName: 'read',
            startedAt: '2026-07-16T10:39:12.872Z',
            args: { path: 'package.json' },
            intent: 'Reading package',
          },
          id: 'tool-start-1',
          parentId: 'assistant-1',
          timestamp: '2026-07-16T10:39:12.872Z',
        },
        {
          type: 'message',
          id: 'tool-result-1',
          parentId: 'tool-start-1',
          timestamp: '2026-07-16T10:39:12.876Z',
          message: {
            role: 'toolResult',
            toolCallId: 'call-read',
            toolName: 'read',
            content: [{ type: 'text', text: '[package.json#ABCD]\n1:{"name":"demo"}' }],
            isError: false,
          },
        },
        {
          type: 'message',
          id: 'assistant-2',
          parentId: 'tool-result-1',
          timestamp: '2026-07-16T10:39:47.170Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Implemented the parser.' }],
            provider: 'openai-codex',
            model: 'gpt-5.5',
          },
        },
        {
          type: 'custom',
          customType: 'session_exit',
          data: { reason: 'dispose', kind: 'normal', recordedAt: '2026-07-16T10:39:52.772Z' },
          id: 'exit-1',
          parentId: 'assistant-2',
          timestamp: '2026-07-16T10:39:52.772Z',
        },
      ],
    );

    const { extractOmpContext } = await loadOmpParser(agentDir);
    const session: UnifiedSession = {
      id: '019f6a82-context-session',
      source: 'omp',
      cwd: '/tmp/project',
      lines: 9,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-07-16T10:38:55.184Z'),
      updatedAt: new Date('2026-07-16T10:39:52.772Z'),
      originalPath,
      summary: 'Add OMP support',
      model: 'openai-codex/gpt-5.5',
    };

    const context = await extractOmpContext(session);

    expect(context.recentMessages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Add support for OMP sessions.'],
      ['assistant', 'Implemented the parser.'],
    ]);
    expect(context.toolSummaries).toEqual([
      expect.objectContaining({
        name: 'Read',
        count: 1,
        samples: [expect.objectContaining({ summary: 'read package.json' })],
      }),
    ]);
    expect(context.sessionNotes?.model).toBe('openai-codex/gpt-5.5');
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      sessionId: '019f6a82-context-session',
      cliVersion: 'v3',
      provider: 'openai-codex',
      thinkingLevel: 'high',
    });
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 100, output: 40 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 3, read: 12 });
    expect(context.sessionNotes?.thinkingTokens).toBe(7);
    expect(context.sessionNotes?.lifecycle).toEqual([
      expect.objectContaining({ type: 'session_exit', timestamp: '2026-07-16T10:39:52.772Z' }),
    ]);
    expect(context.timeline?.map((event) => event.kind)).toContain('tool_call');
    expect(context.markdown).toContain('| **Source** | Oh My Pi |');
    expect(context.markdown).toContain('Add support for OMP sessions.');
  });
});

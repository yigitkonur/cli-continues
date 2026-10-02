import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext, UnifiedSession } from '../types/index.js';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../utils/index.js', () => ({
  extractContext: vi.fn<() => Promise<SessionContext>>(),
  saveContext: vi.fn(),
}));

const { configuredToolArgs, nativeResume } = await import('../utils/resume.js');

const session: UnifiedSession = {
  id: 'abc',
  source: 'claude',
  cwd: process.cwd(),
  lines: 0,
  bytes: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  originalPath: '',
};

afterEach(() => {
  vi.unstubAllEnvs();
  spawnMock.mockReset();
});

describe('CONTINUES_<TOOL>_ARGS', () => {
  it('parses whitespace-separated args, empty when unset', () => {
    vi.stubEnv('CONTINUES_CLAUDE_ARGS', '');
    expect(configuredToolArgs('claude')).toEqual([]);
    vi.stubEnv('CONTINUES_CLAUDE_ARGS', '  --dangerously-skip-permissions  --model opus ');
    expect(configuredToolArgs('claude')).toEqual(['--dangerously-skip-permissions', '--model', 'opus']);
    vi.stubEnv('CONTINUES_QWEN_CODE_ARGS', '--yolo');
    expect(configuredToolArgs('qwen-code')).toEqual(['--yolo']);
  });

  it('appends the configured args to a native resume launch', async () => {
    vi.stubEnv('CONTINUES_CLAUDE_ARGS', '--dangerously-skip-permissions');
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });

    await nativeResume(session);

    const launchArgs = spawnMock.mock.calls.at(-1)?.[1] as string[];
    expect(launchArgs.slice(-3)).toEqual(['--resume', 'abc', '--dangerously-skip-permissions']);
  });
});

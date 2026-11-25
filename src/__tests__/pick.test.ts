import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSource, UnifiedSession } from '../types/index.js';

const testState = vi.hoisted(() => ({
  checkSingleToolAutoResume: vi.fn(),
  getAllSessions: vi.fn(),
  getSessionsByCwd: vi.fn(),
  getSessionsBySource: vi.fn(),
  nativeResume: vi.fn(),
  resume: vi.fn(),
  select: vi.fn(),
  selectTargetTool: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
  outro: vi.fn(),
  select: testState.select,
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../display/banner.js', () => ({
  showBanner: vi.fn(async () => false),
}));

vi.mock('../display/star-prompt.js', () => ({
  maybePromptGithubStar: vi.fn(async () => undefined),
}));

vi.mock('../utils/index.js', () => ({
  getAllSessions: testState.getAllSessions,
  getSessionsByCwd: testState.getSessionsByCwd,
  getSessionsBySource: testState.getSessionsBySource,
}));

vi.mock('../utils/resume.js', () => ({
  enterSessionDir: vi.fn(),
  getResumeCommand: vi.fn(() => 'continues resume selected'),
  nativeResume: testState.nativeResume,
  resolveCrossToolForwarding: vi.fn(() => ({ warnings: [] })),
  resume: testState.resume,
}));

vi.mock('../commands/_shared.js', () => ({
  checkSingleToolAutoResume: testState.checkSingleToolAutoResume,
  selectTargetTool: testState.selectTargetTool,
  showForwardingWarnings: vi.fn(async () => undefined),
}));

const { interactivePick } = await import('../commands/pick.js');

function makeSession(id: string, source: SessionSource, cwd = process.cwd()): UnifiedSession {
  const now = new Date('2026-04-15T00:00:00.000Z');
  return {
    id,
    source,
    cwd,
    lines: 1,
    bytes: 100,
    createdAt: now,
    updatedAt: now,
    originalPath: `/tmp/${id}.jsonl`,
  };
}

describe('interactivePick cwd fallback', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    testState.checkSingleToolAutoResume.mockReset();
    testState.getAllSessions.mockReset();
    testState.getSessionsByCwd.mockReset();
    testState.getSessionsBySource.mockReset();
    testState.nativeResume.mockReset();
    testState.resume.mockReset();
    testState.select.mockReset();
    testState.selectTargetTool.mockReset();
  });

  it('auto-resumes a single cwd session found after full fallback loading', async () => {
    const session = makeSession('only-cwd-session', 'codex');
    testState.getSessionsByCwd.mockResolvedValue([]);
    testState.getAllSessions.mockResolvedValue([session]);
    testState.checkSingleToolAutoResume.mockResolvedValue(true);

    await interactivePick({}, { isTTY: true, supportsColor: false, version: '0.0.0-test' });

    expect(testState.getAllSessions).toHaveBeenCalledTimes(1);
    expect(testState.checkSingleToolAutoResume).toHaveBeenCalledWith(session, testState.nativeResume);
    expect(testState.select).not.toHaveBeenCalled();
  });
});

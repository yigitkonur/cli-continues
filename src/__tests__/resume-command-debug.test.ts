import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const findSessionMock = vi.fn<() => Promise<UnifiedSession | null>>();
const getAllSessionsMock = vi.fn();
const formatSessionMock = vi.fn(() => '[claude] test session');
const resumeMock = vi.fn();
const getResumeCommandMock = vi.fn(() => 'continues resume resume-debug-test --in codex');
const resolveCrossToolForwardingMock = vi.fn(() => ({
  mappedArgs: [],
  passthroughArgs: [],
  extraArgs: [],
  warnings: [],
  parsed: { tokens: [], occurrences: [] },
  consumedIndices: new Set<number>(),
}));

vi.mock('../utils/index.js', () => ({
  findSession: findSessionMock,
  getAllSessions: getAllSessionsMock,
  formatSession: formatSessionMock,
}));

vi.mock('../utils/resume.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../utils/resume.js')>();
  return {
    ...orig,
    resume: resumeMock,
    getResumeCommand: getResumeCommandMock,
    resolveCrossToolForwarding: resolveCrossToolForwardingMock,
  };
});

vi.mock('../commands/_shared.js', () => ({
  selectTargetTool: vi.fn(),
  showForwardingWarnings: vi.fn(),
}));

const { resumeCommand } = await import('../commands/resume-cmd.js');

function makeSession(): UnifiedSession {
  return {
    id: 'resume-debug-test',
    source: 'claude',
    cwd: '/tmp/project',
    repo: 'test/repo',
    branch: 'main',
    summary: 'Test debug prompt passthrough',
    lines: 10,
    bytes: 100,
    createdAt: new Date('2026-04-15T00:00:00.000Z'),
    updatedAt: new Date('2026-04-15T00:00:00.000Z'),
    originalPath: '/tmp/project/session.jsonl',
  };
}

describe('resumeCommand debug prompt option', () => {
  const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
    // Silence command output during tests.
  });

  afterEach(() => {
    findSessionMock.mockReset();
    getAllSessionsMock.mockReset();
    resumeMock.mockReset();
    getResumeCommandMock.mockClear();
    resolveCrossToolForwardingMock.mockClear();
    logSpy.mockClear();
    process.exitCode = undefined;
  });

  it('forwards debugPrompt to resume and suppresses the normal session/command preamble', async () => {
    findSessionMock.mockResolvedValue(makeSession());

    await resumeCommand('resume-debug-test', { in: 'codex', noTui: true, debugPrompt: true } as never, {
      isTTY: false,
    });

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock.mock.calls[0]?.[4]).toMatchObject({ debugPrompt: true });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).not.toContain('Session:');
    expect(output).not.toContain('Command:');
    expect(chdirSpy).toHaveBeenCalledWith('/tmp/project');
  });
});

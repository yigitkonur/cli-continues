import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext, UnifiedSession } from '../types/index.js';

const spawnMock = vi.fn();
const extractContextMock = vi.fn<() => Promise<SessionContext>>();
const saveContextMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../utils/index.js', () => ({
  extractContext: extractContextMock,
  saveContext: saveContextMock,
}));

const { crossToolResume } = await import('../utils/resume.js');

function makeSession(cwd: string): UnifiedSession {
  return {
    id: 'resume-debug-test',
    source: 'claude',
    cwd,
    repo: 'test/repo',
    branch: 'main',
    summary: 'Carry parser redesign context into codex',
    lines: 10,
    bytes: 100,
    createdAt: new Date('2026-04-15T00:00:00.000Z'),
    updatedAt: new Date('2026-04-15T00:00:00.000Z'),
    originalPath: path.join(cwd, 'session.jsonl'),
  };
}

function makeContext(session: UnifiedSession): SessionContext {
  return {
    session,
    recentMessages: [
      { role: 'user', content: 'Investigate parser drift.' },
      { role: 'assistant', content: 'I found several mismatches.' },
    ],
    filesModified: ['src/utils/markdown.ts'],
    pendingTasks: ['Implement pointer-first handoff'],
    toolSummaries: [],
    markdown: '# Session Handoff Context\n\nResearch-backed handoff body.',
  };
}

describe('crossToolResume debug prompt mode', () => {
  let cwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-debug-prompt-'));
    spawnMock.mockReset();
    extractContextMock.mockReset();
    saveContextMock.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      // Silence prompt output during tests.
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('prints the inline handoff prompt and does not launch the target CLI', async () => {
    const session = makeSession(cwd);
    extractContextMock.mockResolvedValue(makeContext(session));

    await crossToolResume(session, 'codex', 'inline', undefined, { debugPrompt: true } as never);

    const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain("I'm continuing a coding session from **Claude Code**");
    expect(output).toContain('# Session Handoff Context');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, '.continues-handoff-resume-debug-test.md'))).toBe(true);
  });

  it('prints the reference handoff prompt and does not launch the target CLI', async () => {
    const session = makeSession(cwd);
    extractContextMock.mockResolvedValue(makeContext(session));

    await crossToolResume(session, 'codex', 'reference', undefined, { debugPrompt: true } as never);

    const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain('# 🔄 Session Handoff');
    expect(output).toContain('.continues-handoff-resume-debug-test.md');
    expect(output).toContain('Read `.continues-handoff-resume-debug-test.md` first, then continue the work.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('writes one handoff file per session so handoffs in the same directory do not overwrite each other', async () => {
    const a = { ...makeSession(cwd), id: 'session-a' };
    const b = { ...makeSession(cwd), id: 'session-b' };
    extractContextMock.mockResolvedValueOnce({ ...makeContext(a), markdown: 'context A' });
    extractContextMock.mockResolvedValueOnce({ ...makeContext(b), markdown: 'context B' });

    await crossToolResume(a, 'codex', 'reference', undefined, { debugPrompt: true } as never);
    await crossToolResume(b, 'codex', 'reference', undefined, { debugPrompt: true } as never);

    expect(fs.readFileSync(path.join(cwd, '.continues-handoff-session-a.md'), 'utf8')).toBe('context A');
    expect(fs.readFileSync(path.join(cwd, '.continues-handoff-session-b.md'), 'utf8')).toBe('context B');
    const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(output).toContain('.continues-handoff-session-a.md');
    expect(output).toContain('.continues-handoff-session-b.md');
  });

  it('rejects invalid runtime targets before extracting context or writing handoff files', async () => {
    const session = makeSession(cwd);

    await expect(crossToolResume(session, 'not-a-tool' as never)).rejects.toThrow('Unknown source: "not-a-tool"');

    expect(extractContextMock).not.toHaveBeenCalled();
    expect(saveContextMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, '.continues-handoff-resume-debug-test.md'))).toBe(false);
  });
});

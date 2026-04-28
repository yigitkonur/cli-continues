import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractQwenCodeContext, parseQwenCodeSessions } from '../parsers/qwen-code.js';
import type { UnifiedSession } from '../types/index.js';

const TEST_CWD = '/workspaces/acme/widget';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const originalQwenRuntimeDir = process.env.QWEN_RUNTIME_DIR;
const originalQwenHome = process.env.QWEN_HOME;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-code-parser-'));
  tempDirs.push(dir);
  return dir;
}

function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function qwenRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    uuid: 'record-id',
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: '2026-01-15T10:00:00.000Z',
    type: 'user',
    cwd: TEST_CWD,
    version: '0.14.5',
    ...overrides,
  };
}

function writeJsonl(filePath: string, lines: Array<Record<string, unknown> | string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`,
  );
}

function writeRuntimeSession(runtimeDir: string, lines: Array<Record<string, unknown> | string>): string {
  const chatsDir = path.join(runtimeDir, 'projects', sanitizeCwd(TEST_CWD), 'chats');
  const sessionPath = path.join(chatsDir, `${SESSION_ID}.jsonl`);
  writeJsonl(sessionPath, lines);
  return sessionPath;
}

function sessionFor(originalPath: string): UnifiedSession {
  return {
    id: SESSION_ID,
    source: 'qwen-code',
    cwd: TEST_CWD,
    repo: 'acme/widget',
    branch: 'main',
    lines: 0,
    bytes: fs.statSync(originalPath).size,
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    updatedAt: new Date('2026-01-15T10:10:00.000Z'),
    originalPath,
    summary: 'Qwen parser test',
    model: 'qwen3-coder-plus',
  };
}

afterEach(() => {
  if (originalQwenRuntimeDir === undefined) {
    delete process.env.QWEN_RUNTIME_DIR;
  } else {
    process.env.QWEN_RUNTIME_DIR = originalQwenRuntimeDir;
  }

  if (originalQwenHome === undefined) {
    delete process.env.QWEN_HOME;
  } else {
    process.env.QWEN_HOME = originalQwenHome;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('qwen-code parser', () => {
  it('parses session metadata from Qwen runtime projects/chats JSONL and skips malformed lines', async () => {
    const runtimeDir = makeTempDir();
    process.env.QWEN_RUNTIME_DIR = runtimeDir;
    delete process.env.QWEN_HOME;

    const sessionPath = writeRuntimeSession(runtimeDir, [
      qwenRecord({
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:01.000Z',
        type: 'user',
        gitBranch: 'feature/qwen-hardening',
        message: { role: 'user', parts: [{ text: 'Harden the Qwen Code parser against malformed JSONL.' }] },
      }),
      '{"uuid":',
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:00:05.000Z',
        type: 'assistant',
        model: 'qwen3-coder-plus',
        message: { role: 'model', parts: [{ text: 'I will inspect the stored chat records.' }] },
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 80,
          cachedContentTokenCount: 20,
          thoughtsTokenCount: 15,
        },
      }),
    ]);

    const sessions = await parseQwenCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: SESSION_ID,
      source: 'qwen-code',
      cwd: TEST_CWD,
      repo: 'acme/widget',
      branch: 'feature/qwen-hardening',
      lines: 3,
      bytes: fs.statSync(sessionPath).size,
      summary: 'Harden the Qwen Code parser against malformed JSON',
      model: 'qwen3-coder-plus',
    });
    expect(sessions[0]?.createdAt.toISOString()).toBe('2026-01-15T10:00:01.000Z');
    expect(sessions[0]?.updatedAt.toISOString()).toBe('2026-01-15T10:00:05.000Z');
  });

  it('prefers QWEN_RUNTIME_DIR over QWEN_HOME and keeps QWEN_HOME as a legacy fallback', async () => {
    const runtimeDir = makeTempDir();
    const legacyHome = makeTempDir();
    process.env.QWEN_RUNTIME_DIR = runtimeDir;
    process.env.QWEN_HOME = legacyHome;

    writeRuntimeSession(runtimeDir, [
      qwenRecord({
        uuid: 'runtime-user',
        message: { role: 'user', parts: [{ text: 'Runtime dir session should win.' }] },
      }),
    ]);
    writeRuntimeSession(path.join(legacyHome, '.qwen'), [
      qwenRecord({
        uuid: 'legacy-user',
        sessionId: 'legacy-session',
        message: { role: 'user', parts: [{ text: 'Legacy fallback session.' }] },
      }),
    ]);

    const runtimeSessions = await parseQwenCodeSessions();

    expect(runtimeSessions).toHaveLength(1);
    expect(runtimeSessions[0]?.id).toBe(SESSION_ID);
    expect(runtimeSessions[0]?.summary).toBe('Runtime dir session should win.');

    delete process.env.QWEN_RUNTIME_DIR;

    const legacySessions = await parseQwenCodeSessions();

    expect(legacySessions).toHaveLength(1);
    expect(legacySessions[0]?.id).toBe('legacy-session');
    expect(legacySessions[0]?.summary).toBe('Legacy fallback session.');
  });

  it('recovers glued JSONL records on one physical line while skipping malformed fragments', async () => {
    const runtimeDir = makeTempDir();
    process.env.QWEN_RUNTIME_DIR = runtimeDir;
    delete process.env.QWEN_HOME;

    const userRecord = qwenRecord({
      uuid: 'u-glued',
      timestamp: '2026-01-15T10:00:00.000Z',
      message: { role: 'user', parts: [{ text: 'Recover glued Qwen JSONL records.' }] },
    });
    const assistantRecord = qwenRecord({
      uuid: 'a-glued',
      parentUuid: 'u-glued',
      timestamp: '2026-01-15T10:01:00.000Z',
      type: 'assistant',
      model: 'qwen3-coder-plus',
      message: { role: 'model', parts: [{ text: 'Recovered the glued record.' }] },
    });
    const sessionPath = writeRuntimeSession(runtimeDir, [
      `${JSON.stringify(userRecord)}${JSON.stringify(assistantRecord)}`,
      '{"uuid":',
    ]);

    const sessions = await parseQwenCodeSessions();
    const context = await extractQwenCodeContext(sessionFor(sessionPath));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      lines: 2,
      summary: 'Recover glued Qwen JSONL records.',
      model: 'qwen3-coder-plus',
    });
    expect(sessions[0]?.updatedAt.toISOString()).toBe('2026-01-15T10:01:00.000Z');
    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Recover glued Qwen JSONL records.',
      'Recovered the glued record.',
    ]);
  });

  it('recovers a valid JSON object that follows a malformed fragment on the same line', async () => {
    const runtimeDir = makeTempDir();
    process.env.QWEN_RUNTIME_DIR = runtimeDir;
    delete process.env.QWEN_HOME;

    const validRecord = qwenRecord({
      uuid: 'u-recovered',
      timestamp: '2026-01-15T10:05:00.000Z',
      message: { role: 'user', parts: [{ text: 'Recover after a leading malformed fragment.' }] },
    });

    // The first object opens a string that never closes ("garbage), so depth
    // never returns to zero. The recovery scan must skip past that opening
    // brace and still find the trailing valid object on the same line.
    writeRuntimeSession(runtimeDir, [`{"unterminated": "garbage${JSON.stringify(validRecord)}`]);

    const sessions = await parseQwenCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.summary).toBe('Recover after a leading malformed fragment.');
  });

  it('silently skips top-level arrays and scalars while keeping intervening objects', async () => {
    const runtimeDir = makeTempDir();
    process.env.QWEN_RUNTIME_DIR = runtimeDir;
    delete process.env.QWEN_HOME;

    const validRecord = qwenRecord({
      uuid: 'u-around-garbage',
      timestamp: '2026-01-15T10:06:00.000Z',
      message: { role: 'user', parts: [{ text: 'Top-level garbage must not produce records.' }] },
    });

    writeRuntimeSession(runtimeDir, [`[1,2,3] "string" 42 ${JSON.stringify(validRecord)} null`]);

    const sessions = await parseQwenCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.summary).toBe('Top-level garbage must not produce records.');
  });

  it('preserves earlier function calls when an assistant uuid is appended in multiple fragments', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Run two distinct shell calls across fragments.' }] },
      }),
      qwenRecord({
        uuid: 'a-frag',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ functionCall: { id: 'call-first', name: 'Bash', args: { command: 'echo first' } } }],
        },
      }),
      qwenRecord({
        uuid: 'a-frag',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:02:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ functionCall: { id: 'call-second', name: 'Bash', args: { command: 'echo second' } } }],
        },
      }),
      qwenRecord({
        uuid: 't1',
        parentUuid: 'a-frag',
        timestamp: '2026-01-15T10:03:00.000Z',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                callId: 'call-first',
                name: 'Bash',
                response: { output: 'first output', status: 'ok' },
              },
            },
            {
              functionResponse: {
                callId: 'call-second',
                name: 'Bash',
                response: { output: 'second output', status: 'ok' },
              },
            },
          ],
        },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));
    const bashSummary = context.toolSummaries.find((summary) => summary.name === 'Bash');

    // Both function calls (one per fragment) must survive aggregation and
    // reach `extractToolData`, so we expect two paired Bash summaries — not
    // just the latest fragment's call.
    expect(bashSummary?.count).toBe(2);
    const summaries = (bashSummary?.samples ?? []).map((sample) => sample.summary);
    expect(summaries.some((line) => line.includes('$ echo first') && line.includes('first output'))).toBe(true);
    expect(summaries.some((line) => line.includes('$ echo second') && line.includes('second output'))).toBe(true);
  });

  it('uses append-order main path instead of a newer abandoned branch', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        timestamp: '2026-01-15T10:00:00.000Z',
        message: { role: 'user', parts: [{ text: 'Start the parser hardening.' }] },
      }),
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'I found the Qwen storage code.' }] },
      }),
      qwenRecord({
        uuid: 'u-stale',
        parentUuid: 'a1',
        timestamp: '2026-01-15T10:20:00.000Z',
        message: { role: 'user', parts: [{ text: 'This abandoned branch should not win.' }] },
      }),
      qwenRecord({
        uuid: 'a-stale',
        parentUuid: 'u-stale',
        timestamp: '2026-01-15T10:21:00.000Z',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'Stale branch response.' }] },
      }),
      qwenRecord({
        uuid: 'u-active',
        parentUuid: 'a1',
        timestamp: '2026-01-15T10:02:00.000Z',
        message: { role: 'user', parts: [{ text: 'Continue on the active branch.' }] },
      }),
      qwenRecord({
        uuid: 'a-active',
        parentUuid: 'u-active',
        timestamp: '2026-01-15T10:03:00.000Z',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'Active branch response.' }] },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));

    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Start the parser hardening.',
      'I found the Qwen storage code.',
      'Continue on the active branch.',
      'Active branch response.',
    ]);
  });

  it('falls back to append order when parent links are broken', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Keep this earlier user turn.' }] },
      }),
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'Keep this earlier assistant turn.' }] },
      }),
      qwenRecord({
        uuid: 'u2',
        parentUuid: 'missing-parent',
        timestamp: '2026-01-15T10:02:00.000Z',
        message: { role: 'user', parts: [{ text: 'The latest parent link is broken.' }] },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));

    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Keep this earlier user turn.',
      'Keep this earlier assistant turn.',
      'The latest parent link is broken.',
    ]);
  });

  it('aggregates duplicate UUID records without losing appended message parts', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Inspect duplicate UUID records.' }] },
      }),
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'First assistant fragment.' }] },
      }),
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:02:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { text: 'Need to keep the appended duplicate fragment.', thought: true },
            { text: 'Second fragment.' },
          ],
        },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));

    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Inspect duplicate UUID records.',
      'First assistant fragment.\nSecond fragment.',
    ]);
    expect(context.pendingTasks).toEqual(['Need to keep the appended duplicate fragment.']);
  });

  it('combines assistant functionCall parts with separate tool_result functionResponse output', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Run the targeted tests.' }] },
      }),
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ functionCall: { name: 'Bash', args: { command: 'pnpm vitest qwen-code-parser.test.ts' } } }],
        },
      }),
      qwenRecord({
        uuid: 't1',
        parentUuid: 'a1',
        timestamp: '2026-01-15T10:02:00.000Z',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'Bash',
                response: { output: 'all qwen parser tests passed', status: 'ok' },
              },
            },
          ],
        },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));
    const bashSummary = context.toolSummaries.find((summary) => summary.name === 'Bash');

    expect(bashSummary?.count).toBe(1);
    expect(bashSummary?.samples[0]?.summary).toContain('$ pnpm vitest qwen-code-parser.test.ts');
    expect(bashSummary?.samples[0]?.summary).toContain('all qwen parser tests passed');
  });

  it('matches duplicate same-tool results by callId instead of tool name', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Run two shell calls with separate outputs.' }] },
      }),
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { functionCall: { id: 'call-first', name: 'Bash', args: { command: 'echo first' } } },
            { functionCall: { id: 'call-second', name: 'Bash', args: { command: 'echo second' } } },
          ],
        },
      }),
      qwenRecord({
        uuid: 't1',
        parentUuid: 'a1',
        timestamp: '2026-01-15T10:02:00.000Z',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                callId: 'call-second',
                name: 'Bash',
                response: { output: 'second output', status: 'ok' },
              },
            },
            {
              functionResponse: {
                callId: 'call-first',
                name: 'Bash',
                response: { output: 'first output', status: 'ok' },
              },
            },
          ],
        },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));
    const bashSummary = context.toolSummaries.find((summary) => summary.name === 'Bash');

    expect(bashSummary?.count).toBe(2);
    expect(bashSummary?.samples[0]?.summary).toContain('$ echo first');
    expect(bashSummary?.samples[0]?.summary).toContain('first output');
    expect(bashSummary?.samples[0]?.summary).not.toContain('second output');
    expect(bashSummary?.samples[1]?.summary).toContain('$ echo second');
    expect(bashSummary?.samples[1]?.summary).toContain('second output');
  });

  it('uses confirmed tool_result file diffs for edits and new files without double-counting inline calls', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Apply the requested file edits.' }] },
      }),
      qwenRecord({
        uuid: 'a-edit',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ functionCall: { name: 'Edit', args: { file_path: '/workspaces/acme/widget/src/app.ts' } } }],
        },
      }),
      qwenRecord({
        uuid: 't-edit',
        parentUuid: 'a-edit',
        timestamp: '2026-01-15T10:02:00.000Z',
        type: 'tool_result',
        toolCallResult: {
          displayName: 'Edit',
          status: 'success',
          resultDisplay: {
            fileName: 'app.ts',
            fileDiff: '--- app.ts\n+++ app.ts\n-old line\n+new line\n+another new line',
            originalContent: 'old line',
            newContent: 'new line\nanother new line',
            diffStat: { model_added_lines: 2, model_removed_lines: 1 },
          },
        },
      }),
      qwenRecord({
        uuid: 'a-write',
        parentUuid: 't-edit',
        timestamp: '2026-01-15T10:03:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ functionCall: { name: 'Write', args: { file_path: '/workspaces/acme/widget/src/new-file.ts' } } }],
        },
      }),
      qwenRecord({
        uuid: 't-write',
        parentUuid: 'a-write',
        timestamp: '2026-01-15T10:04:00.000Z',
        type: 'tool_result',
        toolCallResult: {
          displayName: 'Write',
          status: 'ok',
          resultDisplay: {
            fileName: 'new-file.ts',
            fileDiff: '--- new-file.ts\n+++ new-file.ts\n+export const created = true;',
            originalContent: null,
            newContent: 'export const created = true;',
            diffStat: { model_added_lines: 1, model_removed_lines: 0 },
          },
        },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));
    const editSummary = context.toolSummaries.find((summary) => summary.name === 'Edit');
    const writeSummary = context.toolSummaries.find((summary) => summary.name === 'Write');

    expect(context.filesModified).toEqual([
      '/workspaces/acme/widget/src/app.ts',
      '/workspaces/acme/widget/src/new-file.ts',
    ]);
    expect(editSummary?.count).toBe(1);
    expect(editSummary?.samples[0]?.summary).toContain('edit /workspaces/acme/widget/src/app.ts (+2 -1 lines)');
    expect(editSummary?.samples[0]?.data).toMatchObject({
      category: 'edit',
      filePath: '/workspaces/acme/widget/src/app.ts',
      diffStats: { added: 2, removed: 1 },
    });
    expect(writeSummary?.count).toBe(1);
    expect(writeSummary?.samples[0]?.summary).toContain('write /workspaces/acme/widget/src/new-file.ts (new file)');
    expect(writeSummary?.samples[0]?.data).toMatchObject({
      category: 'write',
      filePath: '/workspaces/acme/widget/src/new-file.ts',
      isNewFile: true,
      diffStats: { added: 1, removed: 0 },
    });
  });

  it('preserves callId-matched file diffs when tool_result displayName is absent', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Patch the app entrypoint.' }] },
      }),
      qwenRecord({
        uuid: 'a-edit',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-edit-app',
                name: 'Edit',
                args: { file_path: '/workspaces/acme/widget/src/app.ts' },
              },
            },
          ],
        },
      }),
      qwenRecord({
        uuid: 't-edit',
        parentUuid: 'a-edit',
        timestamp: '2026-01-15T10:02:00.000Z',
        type: 'tool_result',
        toolCallResult: {
          callId: 'call-edit-app',
          status: 'success',
          resultDisplay: {
            fileName: 'app.ts',
            fileDiff: '--- app.ts\n+++ app.ts\n-console.log("old");\n+console.log("new");',
            originalContent: 'console.log("old");',
            newContent: 'console.log("new");',
            diffStat: { model_added_lines: 1, model_removed_lines: 1 },
          },
        },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));
    const editSummary = context.toolSummaries.find((summary) => summary.name === 'Edit');

    expect(context.filesModified).toEqual(['/workspaces/acme/widget/src/app.ts']);
    expect(editSummary?.count).toBe(1);
    expect(editSummary?.samples[0]?.summary).toContain('edit /workspaces/acme/widget/src/app.ts (+1 -1 lines)');
    expect(editSummary?.samples[0]?.data).toMatchObject({
      category: 'edit',
      filePath: '/workspaces/acme/widget/src/app.ts',
      diffStats: { added: 1, removed: 1 },
    });
  });

  it('generates context with assistant text, reasoning, pending tasks, and token notes', async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Finish hardening the parser.' }] },
      }),
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        model: 'qwen3-coder-plus',
        message: {
          role: 'model',
          parts: [
            { text: 'Need to add the remaining Qwen parser tests next.', thought: true },
            { text: 'I have the parser changes ready.' },
          ],
        },
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 40,
          cachedContentTokenCount: 25,
          thoughtsTokenCount: 12,
        },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));

    expect(context.recentMessages).toEqual([
      {
        role: 'user',
        content: 'Finish hardening the parser.',
        timestamp: new Date('2026-01-15T10:00:00.000Z'),
      },
      {
        role: 'assistant',
        content: 'I have the parser changes ready.',
        timestamp: new Date('2026-01-15T10:01:00.000Z'),
      },
    ]);
    expect(context.pendingTasks).toEqual(['Need to add the remaining Qwen parser tests next.']);
    expect(context.sessionNotes).toMatchObject({
      model: 'qwen3-coder-plus',
      reasoning: ['Need to add the remaining Qwen parser tests next.'],
      tokenUsage: { input: 100, output: 40 },
      cacheTokens: { creation: 0, read: 25 },
      thinkingTokens: 12,
    });
    expect(context.session.model).toBe('qwen3-coder-plus');
    expect(context.markdown).toContain('Qwen Code');
    expect(context.markdown).toContain('I have the parser changes ready.');
  });

  it('skips oversized JSONL records (16MB threshold) without dropping later valid records', async () => {
    const runtimeDir = makeTempDir();
    process.env.QWEN_RUNTIME_DIR = runtimeDir;
    delete process.env.QWEN_HOME;

    const goodRecord = qwenRecord({
      uuid: 'u-good',
      timestamp: '2026-01-15T10:00:00.000Z',
      message: { role: 'user', parts: [{ text: 'Survive past the oversized line.' }] },
    });
    // Build a > 16 MiB single physical line. The shared scanner skips it via
    // MAX_QWEN_JSONL_RECORD_CHARS (16 * 1024 * 1024) without buffering the
    // full payload — protecting Node's readline buffer on tool-output-heavy
    // sessions.
    const oversizedPayload = 'x'.repeat(17 * 1024 * 1024);
    const oversizedRecord = JSON.stringify(
      qwenRecord({
        uuid: 'u-oversized',
        timestamp: '2026-01-15T10:01:00.000Z',
        message: { role: 'user', parts: [{ text: oversizedPayload }] },
      }),
    );
    const trailingRecord = qwenRecord({
      uuid: 'a-trailing',
      parentUuid: 'u-good',
      timestamp: '2026-01-15T10:02:00.000Z',
      type: 'assistant',
      message: { role: 'model', parts: [{ text: 'Trailing assistant turn survives.' }] },
    });

    const sessionPath = writeRuntimeSession(runtimeDir, [goodRecord, oversizedRecord, trailingRecord]);
    expect(fs.statSync(sessionPath).size).toBeGreaterThan(16 * 1024 * 1024);

    const sessions = await parseQwenCodeSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.summary).toBe('Survive past the oversized line.');

    const context = await extractQwenCodeContext(sessionFor(sessionPath));

    // Trailing record after the skipped oversized line must still appear.
    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Survive past the oversized line.',
      'Trailing assistant turn survives.',
    ]);
    // The oversized payload must NOT have been buffered (otherwise the skip
    // is just a fiction): the parsed messages stay short.
    for (const message of context.recentMessages) {
      expect(message.content.length).toBeLessThan(1024);
    }
  });

  it('omits ambiguous same-tool calls when both lack a callId rather than mispairing outputs', async () => {
    // Two `Bash` calls in one assistant turn, no callIds, two function
    // responses without callIds — the parser cannot prove which response
    // belongs to which call. It must record the two calls (so the count is
    // accurate) but decline to attach either ambiguous output to a specific
    // call. Anything else is silently confident in a guess.
    const dir = makeTempDir();
    const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
    writeJsonl(sessionPath, [
      qwenRecord({
        uuid: 'u1',
        message: { role: 'user', parts: [{ text: 'Run two bash calls without ids.' }] },
      }),
      qwenRecord({
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-15T10:01:00.000Z',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'Bash', args: { command: 'echo first' } } },
            { functionCall: { name: 'Bash', args: { command: 'echo second' } } },
          ],
        },
      }),
      qwenRecord({
        uuid: 't1',
        parentUuid: 'a1',
        timestamp: '2026-01-15T10:02:00.000Z',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            { functionResponse: { name: 'Bash', response: { output: 'ambiguous A', status: 'ok' } } },
            { functionResponse: { name: 'Bash', response: { output: 'ambiguous B', status: 'ok' } } },
          ],
        },
      }),
    ]);

    const context = await extractQwenCodeContext(sessionFor(sessionPath));
    const bashSummary = context.toolSummaries.find((summary) => summary.name === 'Bash');

    expect(bashSummary?.count).toBe(2);
    // Neither sample may carry a specific output — that would imply a
    // pairing the parser cannot defend.
    for (const sample of bashSummary?.samples ?? []) {
      expect(sample.summary).not.toContain('ambiguous A');
      expect(sample.summary).not.toContain('ambiguous B');
    }
  });
});

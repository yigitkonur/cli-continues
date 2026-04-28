import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSource, UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

interface LoadClineParserOptions {
  onReadFile?: (filePath: string) => void;
}

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-parser-'));
  tempDirs.push(dir);
  return dir;
}

function globalStorageBase(home: string): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
  }
  if (process.platform === 'linux') {
    return path.join(home, '.config', 'Code', 'User', 'globalStorage');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage');
  }
  return path.join(home, '.config', 'Code', 'User', 'globalStorage');
}

function clineCliTasksRoot(clineDir: string): string {
  return path.join(clineDir, 'data', 'tasks');
}

async function loadClineParser(
  home: string,
  options: LoadClineParserOptions = {},
): Promise<typeof import('../parsers/cline.js')> {
  vi.resetModules();
  if (options.onReadFile) {
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readFile: (
          filePath: Parameters<typeof actual.readFile>[0],
          readOptions?: Parameters<typeof actual.readFile>[1],
        ) => {
          options.onReadFile?.(String(filePath));
          return actual.readFile(filePath, readOptions);
        },
      };
    });
  }
  vi.stubEnv('APPDATA', path.join(home, 'AppData', 'Roaming'));
  vi.doMock('../utils/parser-helpers.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/parser-helpers.js')>();
    return {
      ...actual,
      homeDir: () => home,
    };
  });
  vi.doMock('../utils/markdown.js', () => ({
    generateHandoffMarkdown: () => 'mock handoff markdown',
  }));
  return import('../parsers/cline.js');
}

function writeTaskAtRoot(tasksRoot: string, taskId: string, messages: unknown[]): string {
  const taskDir = path.join(tasksRoot, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
  return filePath;
}

function writeRawTaskAtRoot(tasksRoot: string, taskId: string, content: string): string {
  const taskDir = path.join(tasksRoot, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function extensionTasksRoot(home: string, extensionId: string): string {
  return path.join(globalStorageBase(home), extensionId, 'tasks');
}

function writeTask(home: string, extensionId: string, taskId: string, messages: unknown[]): string {
  return writeTaskAtRoot(extensionTasksRoot(home, extensionId), taskId, messages);
}

function writeRawTask(home: string, extensionId: string, taskId: string, content: string): string {
  return writeRawTaskAtRoot(extensionTasksRoot(home, extensionId), taskId, content);
}

function taskDirFor(originalPath: string): string {
  return path.dirname(originalPath);
}

function writeCompanion(originalPath: string, fileName: string, content: unknown): string {
  const filePath = path.join(taskDirFor(originalPath), fileName);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
  return filePath;
}

function writeTaskHistory(originalPath: string, items: unknown[]): string {
  const storageRoot = path.dirname(path.dirname(taskDirFor(originalPath)));
  const stateDir = path.join(storageRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, 'taskHistory.json');
  fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf8');
  return filePath;
}

function sessionFor(source: SessionSource, originalPath: string, id = `${source}-task`): UnifiedSession {
  return {
    id,
    source,
    cwd: '',
    lines: 1,
    bytes: fs.statSync(originalPath).size,
    createdAt: new Date('2026-04-15T10:00:00.000Z'),
    updatedAt: new Date('2026-04-15T10:00:00.000Z'),
    originalPath,
    summary: 'Parser hardening',
  } satisfies UnifiedSession;
}

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('../utils/parser-helpers.js');
  vi.doUnmock('../utils/markdown.js');
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('Cline-family parser hardening', () => {
  it('discovers Cline CLI task roots from CLINE_DIR and ~/.cline without affecting Roo/Kilo', async () => {
    const home = makeHome();
    const customClineDir = path.join(home, 'custom-cline-dir');
    vi.stubEnv('CLINE_DIR', customClineDir);

    writeTaskAtRoot(clineCliTasksRoot(customClineDir), 'env-cli-task', [
      { ts: 1770000000000, type: 'say', say: 'task', text: 'Parse task from CLINE_DIR' },
    ]);
    writeTaskAtRoot(path.join(home, '.cline', 'data', 'tasks'), 'home-cli-task', [
      { ts: 1770000001000, type: 'say', say: 'task', text: 'Parse task from home Cline dir' },
    ]);

    const { parseClineSessions, parseRooCodeSessions, parseKiloCodeSessions } = await loadClineParser(home);

    const clineSessions = await parseClineSessions();
    const rooSessions = await parseRooCodeSessions();
    const kiloSessions = await parseKiloCodeSessions();

    expect(clineSessions.map((session) => session.id).sort()).toEqual(['env-cli-task', 'home-cli-task']);
    expect(clineSessions.every((session) => session.source === 'cline')).toBe(true);
    expect(clineSessions.map((session) => session.summary).sort()).toEqual([
      'Parse task from CLINE_DIR',
      'Parse task from home Cline dir',
    ]);
    expect(rooSessions).toEqual([]);
    expect(kiloSessions).toEqual([]);
  });

  it('discovers and labels Cline, Roo Code, and Kilo Code task storage variants', async () => {
    const home = makeHome();
    writeTask(home, 'saoudrizwan.claude-dev', 'cline-task', [
      { ts: 1770000000000, type: 'say', say: 'task', text: 'Build the Cline parser fixture' },
    ]);
    writeTask(home, 'rooveterinaryinc.roo-cline', 'roo-legacy-task', [
      { ts: 1770000001000, type: 'say', say: 'text', text: 'Build the legacy Roo parser fixture' },
    ]);
    writeTask(home, 'roo-code.roo-cline', 'roo-current-task', [
      { ts: 1770000002000, type: 'say', say: 'text', text: 'Build the current Roo parser fixture' },
    ]);
    writeTask(home, 'kilocode.kilo-code', 'kilo-task', [
      { ts: 1770000003000, type: 'say', say: 'text', text: 'Build the Kilo parser fixture' },
    ]);

    const { parseClineSessions, parseRooCodeSessions, parseKiloCodeSessions } = await loadClineParser(home);

    const clineSessions = await parseClineSessions();
    const rooSessions = await parseRooCodeSessions();
    const kiloSessions = await parseKiloCodeSessions();

    expect(clineSessions).toHaveLength(1);
    expect(clineSessions[0]).toMatchObject({
      id: 'cline-task',
      source: 'cline',
      summary: 'Build the Cline parser fixture',
    });
    expect(clineSessions[0].originalPath).toContain('saoudrizwan.claude-dev');

    expect(rooSessions.map((session) => session.id).sort()).toEqual(['roo-current-task', 'roo-legacy-task']);
    expect(rooSessions.every((session) => session.source === 'roo-code')).toBe(true);
    expect(rooSessions.map((session) => session.summary).sort()).toEqual([
      'Build the current Roo parser fixture',
      'Build the legacy Roo parser fixture',
    ]);

    expect(kiloSessions).toHaveLength(1);
    expect(kiloSessions[0]).toMatchObject({
      id: 'kilo-task',
      source: 'kilo-code',
      summary: 'Build the Kilo parser fixture',
    });
    expect(kiloSessions[0].originalPath).toContain('kilocode.kilo-code');
  });

  it('skips invalid JSON, non-array JSON, malformed entries, and metadata-only tasks during discovery', async () => {
    const home = makeHome();
    writeRawTask(home, 'saoudrizwan.claude-dev', 'invalid-json', '{not valid json');
    writeRawTask(home, 'saoudrizwan.claude-dev', 'non-array-json', JSON.stringify({ type: 'say', say: 'task' }));
    writeTask(home, 'saoudrizwan.claude-dev', 'metadata-only', [
      null,
      42,
      {},
      { type: 'say', say: 'api_req_started', text: '{"tokensIn":1}' },
      { type: 'say', say: 'command_output', text: 'metadata noise' },
    ]);
    writeTask(home, 'saoudrizwan.claude-dev', 'valid-task', [
      null,
      { type: 'say', say: 'text', text: { nested: 'not text' } },
      { ts: 1770000100000, type: 'say', say: 'task', text: 'Keep this valid task' },
    ]);

    const { parseClineSessions } = await loadClineParser(home);
    const sessions = await parseClineSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'valid-task',
      summary: 'Keep this valid task',
    });
  });

  it('extracts shared context without duplicating streaming partials or fabricating tool summaries', async () => {
    const home = makeHome();
    const messages = [
      null,
      42,
      { ts: 1770000200000, type: 'say', say: 'task', text: 'Implement parser hardening' },
      { ts: 1770000201000, type: 'say', say: 'api_req_started', text: 'not json' },
      {
        ts: 1770000202000,
        type: 'say',
        say: 'api_req_started',
        text: '{"tokensIn":10,"tokensOut":0,"cacheWrites":2,"cacheReads":3,"cost":0.01}',
      },
      { ts: 1770000203000, type: 'say', say: 'text', text: 'Draft assistant answer', partial: true },
      { ts: 1770000204000, type: 'say', say: 'text', text: 'Final assistant answer', partial: false },
      { ts: 1770000205000, type: 'ask', ask: 'followup', text: 'Should I add parser tests?' },
      { ts: 1770000206000, type: 'say', say: 'user_feedback', text: 'Yes, add parser tests' },
      {
        ts: 1770000207000,
        type: 'say',
        say: 'reasoning',
        reasoning: 'Need to cover malformed messages, streaming finalization, and all source variants.',
      },
      {
        ts: 1770000208000,
        type: 'say',
        say: 'api_req_finished',
        text: '{"totalTokensIn":7,"totalTokensOut":8,"totalCacheWrites":1,"totalCacheReads":4,"totalCost":0.02}',
      },
      {
        ts: 1770000209000,
        type: 'ask',
        ask: 'completion_result',
        text: 'Done with parser hardening.\n- [ ] Run manual release check\nNext step: inspect handoff output',
      },
      { ts: 1770000210000, type: 'say', say: 'command_output', text: 'metadata noise' },
      { ts: 1770000211000, type: 'ask', ask: 'command', text: 'npm test' },
      { ts: 1770000212000, type: 'say', say: 'text', text: { nested: 'not text' } },
    ];
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'context-task', messages);

    const { extractClineContext, extractRooCodeContext, extractKiloCodeContext } = await loadClineParser(home);
    const extractors = [
      ['cline', extractClineContext],
      ['roo-code', extractRooCodeContext],
      ['kilo-code', extractKiloCodeContext],
    ] as const;

    for (const [source, extractContext] of extractors) {
      const context = await extractContext(sessionFor(source, originalPath));
      const contents = context.recentMessages.map((message) => message.content);

      expect(context.recentMessages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'assistant',
        'user',
        'assistant',
        'assistant',
      ]);
      expect(contents).toEqual([
        'Implement parser hardening',
        'Final assistant answer',
        'Should I add parser tests?',
        'Yes, add parser tests',
        'Need to cover malformed messages, streaming finalization, and all source variants.',
        'Done with parser hardening.\n- [ ] Run manual release check\nNext step: inspect handoff output',
      ]);
      expect(contents).not.toContain('Draft assistant answer');
      expect(contents).not.toContain('metadata noise');
      expect(contents).not.toContain('npm test');
      expect(context.sessionNotes?.tokenUsage).toEqual({ input: 17, output: 8 });
      expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 3, read: 7 });
      expect(context.sessionNotes?.reasoning).toEqual([
        'Need to cover malformed messages, streaming finalization, and all source variants.',
      ]);
      expect(context.pendingTasks).toEqual(['- [ ] Run manual release check', 'Next step: inspect handoff output']);
      expect(context.filesModified).toEqual([]);
      expect(context.toolSummaries).toEqual([]);
    }
  });

  it('extracts exact Cline tool activity from api_conversation_history.json', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'api-tool-task', [
      { ts: 1770000300000, type: 'say', say: 'task', text: 'Use exact API history tool calls' },
      { ts: 1770000301000, type: 'say', say: 'text', text: 'I will run tests and edit the parser.', partial: false },
    ]);
    writeCompanion(originalPath, 'api_conversation_history.json', [
      {
        role: 'user',
        ts: 1770000300000,
        content: [
          {
            type: 'text',
            text: 'Use exact API history tool calls\n<environment_details>\n# Current Working Directory (/tmp/cline-api-project) Files\n</environment_details>',
          },
        ],
      },
      {
        role: 'assistant',
        ts: 1770000301000,
        modelInfo: { modelId: 'claude-sonnet-4-20260229', providerId: 'anthropic', mode: 'act' },
        metrics: { tokens: { prompt: 100, completion: 20, cached: 30 }, cost: 0.02 },
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'execute_command', input: { command: 'pnpm test' } },
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'replace_in_file',
            input: { path: 'src/parsers/cline.ts', old_string: 'old', new_string: 'new' },
          },
        ],
      },
      {
        role: 'user',
        ts: 1770000302000,
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'Tests passed' },
          { type: 'tool_result', tool_use_id: 'tool-2', content: [{ type: 'text', text: 'Replaced 1 occurrence' }] },
        ],
      },
    ]);

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'api-tool-task'));
    const toolNames = context.toolSummaries.map((summary) => summary.name).sort();

    expect(toolNames).toEqual(['execute_command', 'replace_in_file']);
    expect(context.toolSummaries.find((summary) => summary.name === 'execute_command')?.samples[0].summary).toContain(
      'pnpm test',
    );
    expect(context.toolSummaries.find((summary) => summary.name === 'execute_command')?.samples[0].summary).toContain(
      'Tests passed',
    );
    expect(context.toolSummaries.find((summary) => summary.name === 'replace_in_file')?.samples[0].summary).toContain(
      'src/parsers/cline.ts',
    );
    expect(context.filesModified).toEqual(['src/parsers/cline.ts']);
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 100, output: 20 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 0, read: 30 });
  });

  it('recovers Cline cwd, model, and usage from task metadata and state task history without double counting', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'metadata-task', [
      { ts: 1770000400000, type: 'say', say: 'task', text: 'Recover metadata fields' },
      {
        ts: 1770000401000,
        type: 'say',
        say: 'api_req_finished',
        text: '{"totalTokensIn":999,"totalTokensOut":999,"totalCacheWrites":999,"totalCacheReads":999}',
      },
      { ts: 1770000402000, type: 'say', say: 'text', text: 'Metadata recovered.', partial: false },
    ]);
    writeCompanion(originalPath, 'task_metadata.json', {
      files_in_context: [],
      model_usage: [
        { ts: 1770000401500, model_id: 'claude-4-opus-metadata', model_provider_id: 'anthropic', mode: 'act' },
      ],
      environment_history: [],
    });
    writeTaskHistory(originalPath, [
      {
        id: 'metadata-task',
        ts: 1770000403000,
        task: 'Recover metadata fields',
        tokensIn: 123,
        tokensOut: 45,
        cacheWrites: 6,
        cacheReads: 7,
        totalCost: 0.03,
        cwdOnTaskInitialization: '/Users/tester/projects/cline-hardening',
        modelId: 'history-model-should-not-win',
      },
    ]);

    const { parseClineSessions, extractClineContext } = await loadClineParser(home);
    const sessions = await parseClineSessions();
    const session = sessions.find((item) => item.id === 'metadata-task');

    expect(session).toMatchObject({
      cwd: '/Users/tester/projects/cline-hardening',
      repo: 'projects/cline-hardening',
      model: 'claude-4-opus-metadata',
    });

    const context = await extractClineContext(session!);

    expect(context.session).toMatchObject({
      cwd: '/Users/tester/projects/cline-hardening',
      repo: 'projects/cline-hardening',
      model: 'claude-4-opus-metadata',
    });
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 123, output: 45 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 6, read: 7 });
  });

  it('loads shared task history once per storage root while listing sessions', async () => {
    const home = makeHome();
    const firstPath = writeTask(home, 'saoudrizwan.claude-dev', 'history-cache-a', [
      { ts: 1770000450000, type: 'say', say: 'task', text: 'Cache task history for first task' },
    ]);
    writeTask(home, 'saoudrizwan.claude-dev', 'history-cache-b', [
      { ts: 1770000451000, type: 'say', say: 'task', text: 'Cache task history for second task' },
    ]);
    writeTaskHistory(firstPath, [
      {
        id: 'history-cache-a',
        ts: 1770000452000,
        cwdOnTaskInitialization: '/tmp/history-cache-a',
        modelId: 'history-model-a',
      },
      {
        id: 'history-cache-b',
        ts: 1770000453000,
        cwdOnTaskInitialization: '/tmp/history-cache-b',
        modelId: 'history-model-b',
      },
    ]);
    const taskHistoryReads: string[] = [];

    const { parseClineSessions } = await loadClineParser(home, {
      onReadFile: (filePath) => {
        if (path.basename(filePath) === 'taskHistory.json') taskHistoryReads.push(filePath);
      },
    });
    const sessions = await parseClineSessions();

    expect(sessions.map((session) => session.id).sort()).toEqual(['history-cache-a', 'history-cache-b']);
    expect(sessions.find((session) => session.id === 'history-cache-a')).toMatchObject({
      cwd: '/tmp/history-cache-a',
      model: 'history-model-a',
    });
    expect(sessions.find((session) => session.id === 'history-cache-b')).toMatchObject({
      cwd: '/tmp/history-cache-b',
      model: 'history-model-b',
    });
    expect(taskHistoryReads).toHaveLength(1);
  });

  it('extracts cwd from request strings inside UI API metadata', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'saoudrizwan.claude-dev', 'request-string-cwd', [
      { ts: 1770000460000, type: 'say', say: 'task', text: 'Recover cwd from request metadata' },
      {
        ts: 1770000461000,
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({
          request: 'Current Working Directory (/tmp/request-string-project) Files\nsrc/parsers/cline.ts',
        }),
      },
    ]);

    const { parseClineSessions, extractClineContext } = await loadClineParser(home);
    const sessions = await parseClineSessions();
    const session = sessions.find((item) => item.id === 'request-string-cwd');

    expect(session).toMatchObject({
      cwd: '/tmp/request-string-project',
      repo: 'tmp/request-string-project',
    });

    const context = await extractClineContext(sessionFor('cline', originalPath, 'request-string-cwd'));

    expect(context.session).toMatchObject({
      cwd: '/tmp/request-string-project',
      repo: 'tmp/request-string-project',
    });
  });

  it('recovers context from API history and metadata when ui_messages.json is malformed', async () => {
    const home = makeHome();
    const originalPath = writeRawTask(home, 'saoudrizwan.claude-dev', 'malformed-ui-fallback', '{not valid json');
    writeCompanion(originalPath, 'task_metadata.json', {
      files_in_context: [],
      model_usage: [
        { ts: 1770000501000, model_id: 'claude-api-fallback-model', model_provider_id: 'anthropic', mode: 'act' },
      ],
      environment_history: [],
    });
    writeCompanion(originalPath, 'api_conversation_history.json', [
      {
        role: 'user',
        ts: 1770000500000,
        content: [
          {
            type: 'text',
            text: 'Recover this malformed UI task\n<environment_details>\nCurrent Working Directory: /tmp/fallback-project\n</environment_details>',
          },
        ],
      },
      {
        role: 'assistant',
        ts: 1770000501000,
        metrics: { tokens: { prompt: 12, completion: 8, cached: 3 } },
        content: [
          {
            type: 'text',
            text: 'Recovered from API history.\n- [ ] Re-run the parser test\nNext step: verify handoff output',
          },
        ],
      },
    ]);

    const { extractClineContext } = await loadClineParser(home);
    const context = await extractClineContext(sessionFor('cline', originalPath, 'malformed-ui-fallback'));

    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Recover this malformed UI task',
      'Recovered from API history.\n- [ ] Re-run the parser test\nNext step: verify handoff output',
    ]);
    expect(context.pendingTasks).toEqual(['- [ ] Re-run the parser test', 'Next step: verify handoff output']);
    expect(context.session).toMatchObject({
      cwd: '/tmp/fallback-project',
      repo: 'tmp/fallback-project',
      model: 'claude-api-fallback-model',
    });
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 12, output: 8 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 0, read: 3 });
  });

  it('returns empty context instead of throwing for invalid or non-array ui_messages.json files', async () => {
    const home = makeHome();
    const invalidPath = writeRawTask(home, 'saoudrizwan.claude-dev', 'invalid-context', '{not valid json');
    const nonArrayPath = writeRawTask(
      home,
      'saoudrizwan.claude-dev',
      'non-array-context',
      JSON.stringify({ ok: true }),
    );

    const { extractClineContext } = await loadClineParser(home);

    for (const originalPath of [invalidPath, nonArrayPath]) {
      const context = await extractClineContext(sessionFor('cline', originalPath));

      expect(context.recentMessages).toEqual([]);
      expect(context.pendingTasks).toEqual([]);
      expect(context.filesModified).toEqual([]);
      expect(context.toolSummaries).toEqual([]);
      expect(context.sessionNotes).toEqual({});
    }
  });
});

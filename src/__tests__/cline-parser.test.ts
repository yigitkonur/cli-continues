import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSource, UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

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

function remoteGlobalStorageBase(home: string): string {
  return path.join(home, '.vscode-server', 'data', 'User', 'globalStorage');
}

function writeUserSettings(home: string, settings: Record<string, unknown>): void {
  const settingsPath = path.join(path.dirname(globalStorageBase(home)), 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

async function loadClineParser(home: string): Promise<typeof import('../parsers/cline.js')> {
  vi.resetModules();
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

function writeTaskAtBase(base: string, extensionId: string, taskId: string, messages: unknown[]): string {
  const taskDir = path.join(base, extensionId, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
  return filePath;
}

function writeTask(home: string, extensionId: string, taskId: string, messages: unknown[]): string {
  return writeTaskAtBase(globalStorageBase(home), extensionId, taskId, messages);
}

function writeCustomStorageTask(customRoot: string, taskId: string, messages: unknown[]): string {
  const taskDir = path.join(customRoot, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
  return filePath;
}

function writeRawTask(home: string, extensionId: string, taskId: string, content: string): string {
  const taskDir = path.join(globalStorageBase(home), extensionId, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const filePath = path.join(taskDir, 'ui_messages.json');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function writeTaskSidecar(originalPath: string, fileName: string, content: unknown): void {
  const taskDir = path.dirname(originalPath);
  const serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(path.join(taskDir, fileName), serialized, 'utf8');
}

function sessionFor(source: SessionSource, originalPath: string): UnifiedSession {
  return {
    id: `${source}-task`,
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
  vi.doUnmock('../utils/parser-helpers.js');
  vi.doUnmock('../utils/markdown.js');
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('Cline-family parser hardening', () => {
  it('discovers and labels Cline, stable Roo Code, legacy Roo compatibility, and Kilo Code task storage variants', async () => {
    const home = makeHome();
    writeTask(home, 'saoudrizwan.claude-dev', 'cline-task', [
      { ts: 1770000000000, type: 'say', say: 'task', text: 'Build the Cline parser fixture' },
    ]);
    writeTask(home, 'rooveterinaryinc.roo-cline', 'roo-stable-task', [
      { ts: 1770000001000, type: 'say', say: 'text', text: 'Build the stable Roo parser fixture' },
    ]);
    writeTask(home, 'roo-code.roo-cline', 'roo-legacy-compat-task', [
      { ts: 1770000002000, type: 'say', say: 'text', text: 'Build the legacy compatibility Roo parser fixture' },
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

    expect(rooSessions.map((session) => session.id).sort()).toEqual(['roo-legacy-compat-task', 'roo-stable-task']);
    expect(rooSessions.every((session) => session.source === 'roo-code')).toBe(true);
    expect(rooSessions.map((session) => session.summary).sort()).toEqual([
      'Build the legacy compatibility Roo parser fixture',
      'Build the stable Roo parser fixture',
    ]);
    expect(rooSessions.find((session) => session.id === 'roo-stable-task')?.originalPath).toContain(
      'rooveterinaryinc.roo-cline',
    );
    expect(rooSessions.find((session) => session.id === 'roo-legacy-compat-task')?.originalPath).toContain(
      'roo-code.roo-cline',
    );

    expect(kiloSessions).toHaveLength(1);
    expect(kiloSessions[0]).toMatchObject({
      id: 'kilo-task',
      source: 'kilo-code',
      summary: 'Build the Kilo parser fixture',
    });
    expect(kiloSessions[0].originalPath).toContain('kilocode.kilo-code');
  });

  it('discovers stable Roo Code sessions from VS Code remote server storage', async () => {
    const home = makeHome();
    const originalPath = writeTaskAtBase(
      remoteGlobalStorageBase(home),
      'rooveterinaryinc.roo-cline',
      'remote-roo-task',
      [{ ts: 1770000004000, type: 'say', say: 'task', text: 'Harden Roo remote storage discovery' }],
    );

    const { parseRooCodeSessions } = await loadClineParser(home);
    const sessions = await parseRooCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'remote-roo-task',
      source: 'roo-code',
      summary: 'Harden Roo remote storage discovery',
      originalPath,
    });
  });

  it('discovers Roo Code sessions from configured custom storage path', async () => {
    const home = makeHome();
    const customRoot = path.join(home, 'roo-custom-storage');
    writeUserSettings(home, { 'roo-cline.customStoragePath': customRoot });
    const originalPath = writeCustomStorageTask(customRoot, 'custom-roo-task', [
      { ts: 1770000005000, type: 'say', say: 'task', text: 'Load the custom Roo storage task' },
    ]);

    const { parseRooCodeSessions } = await loadClineParser(home);
    const sessions = await parseRooCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'custom-roo-task',
      source: 'roo-code',
      summary: 'Load the custom Roo storage task',
      originalPath,
    });
  });

  it('discovers Roo Code sessions from an explicit custom storage environment path', async () => {
    const home = makeHome();
    const customRoot = path.join(home, 'roo-env-storage');
    vi.stubEnv('ROO_CODE_STORAGE_PATH', customRoot);
    const originalPath = writeCustomStorageTask(customRoot, 'env-roo-task', [
      { ts: 1770000006000, type: 'say', say: 'task', text: 'Load the env Roo storage task' },
    ]);

    const { parseRooCodeSessions } = await loadClineParser(home);
    const sessions = await parseRooCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'env-roo-task',
      source: 'roo-code',
      summary: 'Load the env Roo storage task',
      originalPath,
    });
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
        text: '{"tokensIn":10,"tokensOut":4,"cacheWrites":2,"cacheReads":3,"cost":0.01}',
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
        text: '{"totalTokensIn":17,"totalTokensOut":12,"totalCacheWrites":3,"totalCacheReads":7,"totalCost":0.02}',
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
      // Cumulative session totals from `api_req_finished` win over the
      // per-request increments in `api_req_started` to avoid double counting.
      expect(context.sessionNotes?.tokenUsage).toEqual({ input: 17, output: 12 });
      expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 3, read: 7 });
      expect(context.sessionNotes?.reasoning).toEqual([
        'Need to cover malformed messages, streaming finalization, and all source variants.',
      ]);
      expect(context.pendingTasks).toEqual(['- [ ] Run manual release check', 'Next step: inspect handoff output']);
      expect(context.filesModified).toEqual([]);
      expect(context.toolSummaries).toEqual([]);
    }
  });

  it('extracts Roo Code tools, modified files, model, workspace, and token notes from richer task files', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'rooveterinaryinc.roo-cline', 'api-rich-roo-task', [
      { ts: 1770000300000, type: 'say', say: 'task', text: 'Add an auth guard' },
      { ts: 1770000301000, type: 'say', say: 'text', text: 'I will update the guard and tests.' },
    ]);
    writeTaskSidecar(originalPath, 'api_conversation_history.json', [
      { role: 'user', content: 'Add an auth guard', ts: 1770000300000 },
      {
        role: 'assistant',
        ts: 1770000301000,
        content: [
          { type: 'text', text: 'I will edit the auth guard.' },
          {
            type: 'tool_use',
            id: 'toolu_write_1',
            name: 'write_to_file',
            input: { path: 'src/auth.ts', content: 'export const ok = true;' },
          },
        ],
      },
      {
        role: 'user',
        ts: 1770000302000,
        content: [{ type: 'tool_result', tool_use_id: 'toolu_write_1', content: 'File written successfully.' }],
      },
      {
        role: 'assistant',
        ts: 1770000303000,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_shell_1',
            name: 'execute_command',
            input: { command: 'pnpm test -- auth' },
          },
        ],
      },
      {
        role: 'user',
        ts: 1770000304000,
        content: [{ type: 'tool_result', tool_use_id: 'toolu_shell_1', content: 'exit code: 0' }],
      },
    ]);
    writeTaskSidecar(originalPath, 'task_metadata.json', {
      files_in_context: [
        {
          path: 'src/auth.ts',
          record_state: 'active',
          record_source: 'cline_edited',
          cline_read_date: 1770000301000,
          cline_edit_date: 1770000302000,
        },
      ],
      model_usage: [{ ts: 1770000300000, model_id: 'claude-sonnet-4-5', model_provider_id: 'anthropic', mode: 'code' }],
      environment_history: [],
    });
    writeTaskSidecar(originalPath, 'history_item.json', {
      id: 'api-rich-roo-task',
      number: 1,
      ts: 1770000304000,
      task: 'Add an auth guard',
      tokensIn: 123,
      tokensOut: 45,
      cacheWrites: 6,
      cacheReads: 7,
      totalCost: 0.12,
      workspace: '/workspaces/app',
      mode: 'code',
    });

    const { parseRooCodeSessions, extractRooCodeContext } = await loadClineParser(home);
    const sessions = await parseRooCodeSessions();
    const parsedSession = sessions[0];
    const context = await extractRooCodeContext(parsedSession);

    expect(parsedSession).toMatchObject({
      id: 'api-rich-roo-task',
      cwd: '/workspaces/app',
      model: 'claude-sonnet-4-5',
      summary: 'Add an auth guard',
    });
    expect(context.session.model).toBe('claude-sonnet-4-5');
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 123, output: 45 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 6, read: 7 });
    expect(context.filesModified).toEqual(['src/auth.ts']);
    expect(context.toolSummaries.find((summary) => summary.name === 'write')?.samples[0]?.summary).toContain(
      'write src/auth.ts',
    );
    expect(context.toolSummaries.find((summary) => summary.name === 'shell')?.samples[0]?.summary).toContain(
      '$ pnpm test -- auth',
    );
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      apiConversationMessages: 5,
      taskMetadata: { filesInContext: 1, modelUsage: 1 },
      historyItem: { mode: 'code' },
    });
  });

  it('omits API system messages and treats non-path tool args as display-only', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'rooveterinaryinc.roo-cline', 'api-system-roo-task', []);
    writeTaskSidecar(originalPath, 'api_conversation_history.json', [
      { role: 'system', content: 'You are Roo, an autonomous coding assistant.', ts: 1770000310000 },
      { role: 'user', content: 'Investigate the failing test', ts: 1770000311000 },
      {
        role: 'assistant',
        ts: 1770000312000,
        content: [
          { type: 'text', text: 'Let me check the docs.' },
          {
            type: 'tool_use',
            id: 'toolu_edit_no_path_1',
            name: 'apply_diff',
            // Intentionally no path/filePath/relativePath key — the parser must
            // not stringify these args into `filesModified`.
            input: { description: 'rewrite helper', payload: 'diff content here' },
          },
        ],
      },
      {
        role: 'user',
        ts: 1770000313000,
        content: [{ type: 'tool_result', tool_use_id: 'toolu_edit_no_path_1', content: 'ok' }],
      },
    ]);

    const { extractRooCodeContext } = await loadClineParser(home);
    const context = await extractRooCodeContext(sessionFor('roo-code', originalPath));

    // System messages must not appear as conversation turns.
    expect(context.recentMessages.some((message) => message.role === 'system')).toBe(false);
    expect(context.recentMessages.map((message) => message.content)).not.toContain(
      'You are Roo, an autonomous coding assistant.',
    );

    // No path key was provided in the tool input, so filesModified must stay empty.
    expect(context.filesModified).toEqual([]);
    const editSummary = context.toolSummaries.find((summary) => summary.name === 'edit');
    expect(editSummary?.samples[0]?.summary).toBeDefined();
  });

  it('extracts JSON UI tool records before XML fallback', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'rooveterinaryinc.roo-cline', 'json-ui-tool-roo-task', [
      { ts: 1770000350000, type: 'say', say: 'task', text: 'Summarize JSON UI tools' },
      {
        ts: 1770000351000,
        type: 'ask',
        ask: 'tool',
        text: JSON.stringify({
          tool: 'editedExistingFile',
          path: 'src/a.ts',
          content: '<read_file><path>wrong.ts</path></read_file>',
        }),
      },
      {
        ts: 1770000352000,
        type: 'say',
        say: 'tool',
        text: JSON.stringify({ tool: 'appliedDiff', path: 'src/b.ts' }),
      },
    ]);

    const { extractRooCodeContext } = await loadClineParser(home);
    const context = await extractRooCodeContext(sessionFor('roo-code', originalPath));

    const summary = context.toolSummaries.find((item) => item.name === 'ui:editedExistingFile');
    expect(summary?.samples[0]?.summary).toBe('requested editedExistingFile src/a.ts');
    expect(context.toolSummaries.find((item) => item.name === 'ui:appliedDiff')?.samples[0]?.summary).toBe(
      'requested appliedDiff src/b.ts',
    );
    expect(context.toolSummaries.find((item) => item.name === 'ui:read_file')).toBeUndefined();
    expect(context.filesModified).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('adds a fidelity warning when richer Roo sidecar files look partial or locked', async () => {
    const home = makeHome();
    const originalPath = writeTask(home, 'rooveterinaryinc.roo-cline', 'partial-roo-task', [
      { ts: 1770000400000, type: 'say', say: 'task', text: 'Handle partial sidecar writes' },
    ]);
    writeTaskSidecar(originalPath, 'api_conversation_history.json', '[{"role":"assistant","content":');

    const { extractRooCodeContext } = await loadClineParser(home);
    const context = await extractRooCodeContext(sessionFor('roo-code', originalPath));

    expect(context.recentMessages.map((message) => message.content)).toEqual(['Handle partial sidecar writes']);
    expect(context.toolSummaries).toEqual([]);
    expect(context.sessionNotes?.fidelityWarnings?.join('\n')).toContain(
      'api_conversation_history.json could not be read as complete JSON',
    );
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

    // Invalid JSON: the read fails outright, so a fidelity warning must surface.
    const invalidContext = await extractClineContext(sessionFor('cline', invalidPath));
    expect(invalidContext.recentMessages).toEqual([]);
    expect(invalidContext.pendingTasks).toEqual([]);
    expect(invalidContext.filesModified).toEqual([]);
    expect(invalidContext.toolSummaries).toEqual([]);
    expect(invalidContext.sessionNotes?.fidelityWarnings?.join('\n')).toContain(
      'ui_messages.json could not be read as complete JSON',
    );

    // Non-array JSON: parses cleanly but yields no messages — no warning needed.
    const nonArrayContext = await extractClineContext(sessionFor('cline', nonArrayPath));
    expect(nonArrayContext.recentMessages).toEqual([]);
    expect(nonArrayContext.pendingTasks).toEqual([]);
    expect(nonArrayContext.filesModified).toEqual([]);
    expect(nonArrayContext.toolSummaries).toEqual([]);
    expect(nonArrayContext.sessionNotes).toEqual({});
  });
});

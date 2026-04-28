import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

function makeCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parser-'));
  tempDirs.push(dir);
  return dir;
}

function writeRollout(root: string, subdir: string, filename: string, rows: unknown[]): string {
  const targetDir = path.join(root, subdir);
  fs.mkdirSync(targetDir, { recursive: true });
  const fullPath = path.join(targetDir, filename);
  fs.writeFileSync(fullPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return fullPath;
}

async function loadCodexParser(home: string): Promise<typeof import('../parsers/codex.js')> {
  vi.resetModules();
  vi.stubEnv('CODEX_HOME', home);
  return import('../parsers/codex.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe('codex parser hardening', () => {
  it('discovers sessions from both active and archived session trees', async () => {
    const home = makeCodexHome();

    writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T10-00-00-active-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'active-session-id', cwd: '/tmp/active' },
        },
        {
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Active session' },
        },
      ],
    );

    writeRollout(
      home,
      path.join('archived_sessions', '2026', '04', '14'),
      'rollout-2026-04-14T09-00-00-archived-session-id.jsonl',
      [
        {
          timestamp: '2026-04-14T09:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'archived-session-id', cwd: '/tmp/archived' },
        },
        {
          timestamp: '2026-04-14T09:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Archived session' },
        },
      ],
    );

    const { parseCodexSessions } = await loadCodexParser(home);
    const sessions = await parseCodexSessions();

    expect(sessions.map((session) => session.id)).toContain('active-session-id');
    expect(sessions.map((session) => session.id)).toContain('archived-session-id');
  });

  it('extracts token usage from nested token_count payload.info totals', async () => {
    const home = makeCodexHome();
    const originalPath = writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T10-00-00-token-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'token-session-id',
            cwd: '/tmp/project',
            git: { branch: 'main', repository_url: 'https://github.com/user/project.git' },
          },
        },
        {
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Token check' }] },
        },
        {
          timestamp: '2026-04-15T10:00:02.000Z',
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
        },
        {
          timestamp: '2026-04-15T10:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 120,
                output_tokens: 45,
                cached_input_tokens: 17,
                reasoning_output_tokens: 9,
              },
              last_token_usage: {
                input_tokens: 20,
                output_tokens: 5,
                cached_input_tokens: 2,
                reasoning_output_tokens: 1,
              },
            },
          },
        },
      ],
    );

    const { extractCodexContext } = await loadCodexParser(home);
    const session: UnifiedSession = {
      id: 'token-session-id',
      source: 'codex',
      cwd: '/tmp/project',
      repo: 'user/project',
      branch: 'main',
      lines: 4,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T10:00:03.000Z'),
      originalPath,
      summary: 'Token check',
    };

    const context = await extractCodexContext(session);

    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 120, output: 45 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ creation: 0, read: 17 });
    expect(context.sessionNotes?.thinkingTokens).toBe(9);
  });

  it('extracts plaintext compacted payload.message as compact summary', async () => {
    const home = makeCodexHome();
    const originalPath = writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T10-00-00-compact-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'compact-session-id', cwd: '/tmp/project' },
        },
        {
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'compacted',
          payload: {
            message: 'Keep the parser findings and pending fixes.',
            replacement_history: [{ content: 'do not include this injected content' }],
          },
        },
      ],
    );

    const { extractCodexContext } = await loadCodexParser(home);
    const context = await extractCodexContext({
      id: 'compact-session-id',
      source: 'codex',
      cwd: '/tmp/project',
      lines: 2,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T10:00:01.000Z'),
      originalPath,
    });

    expect(context.sessionNotes?.compactSummary).toBe('Keep the parser findings and pending fixes.');
    expect(context.sessionNotes?.compactSummary).not.toContain('injected');
  });

  it('tracks namespaced edit_file function calls as edits and modified files', async () => {
    const home = makeCodexHome();
    const originalPath = writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T10-00-00-edit-file-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'edit-file-session-id', cwd: '/tmp/project' },
        },
        {
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'edit_file',
            namespace: 'mcp__morph__',
            call_id: 'call-edit',
            arguments: JSON.stringify({
              path: 'src/parsers/codex.ts',
              code_edit: '// ... existing code ...\nconst fixed = true;',
            }),
          },
        },
        {
          timestamp: '2026-04-15T10:00:02.000Z',
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-edit', output: 'updated' },
        },
      ],
    );

    const { extractCodexContext } = await loadCodexParser(home);
    const context = await extractCodexContext({
      id: 'edit-file-session-id',
      source: 'codex',
      cwd: '/tmp/project',
      lines: 3,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T10:00:02.000Z'),
      originalPath,
    });

    expect(context.filesModified).toContain('src/parsers/codex.ts');
    const editSummary = context.toolSummaries.find((summary) => summary.name === 'mcp__morph__edit_file');
    expect(editSummary?.samples[0].data).toMatchObject({
      category: 'edit',
      filePath: 'src/parsers/codex.ts',
    });
  });

  it('summarizes write_stdin chars payloads', async () => {
    const home = makeCodexHome();
    const originalPath = writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T10-00-00-stdin-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'stdin-session-id', cwd: '/tmp/project' },
        },
        {
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'write_stdin',
            arguments: JSON.stringify({ chars: 'y\n' }),
          },
        },
      ],
    );

    const { extractCodexContext } = await loadCodexParser(home);
    const context = await extractCodexContext({
      id: 'stdin-session-id',
      source: 'codex',
      cwd: '/tmp/project',
      lines: 2,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T10:00:00.000Z'),
      updatedAt: new Date('2026-04-15T10:00:01.000Z'),
      originalPath,
    });

    const stdinSummary = context.toolSummaries.find((summary) => summary.name === 'write_stdin');
    expect(stdinSummary?.samples[0].summary).toContain('y');
  });

  it('uses session_meta and rollout timestamps while keeping task_started out of tool summaries', async () => {
    const home = makeCodexHome();
    const originalPath = writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T09-00-00-lifecycle-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'lifecycle-session-id',
            timestamp: '2026-04-15T09:59:58.500Z',
            cwd: '/tmp/project',
            originator: 'codex_cli_rs',
            cli_version: '0.99.0',
            source: 'vscode',
            model_provider: 'openai',
            git: {
              branch: 'main',
              repository_url: 'https://github.com/user/project.git',
              commit_hash: '1234567890abcdef',
            },
          },
        },
        {
          timestamp: '2026-04-15T10:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_started',
            message: 'working',
            turn_id: 'turn-1',
            started_at: 1776077875,
            model_context_window: 200000,
            collaboration_mode_kind: 'default',
          },
        },
        {
          timestamp: '2026-04-15T10:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'turn_aborted',
            message: 'interrupted',
            reason: 'interrupted',
            completed_at: 1776077876,
            duration_ms: 47,
          },
        },
      ],
    );

    const { parseCodexSessions, extractCodexContext } = await loadCodexParser(home);
    const [session] = await parseCodexSessions();
    const context = await extractCodexContext(session);

    expect(originalPath).toContain('lifecycle-session-id');
    expect(session.createdAt.toISOString()).toBe('2026-04-15T09:59:58.500Z');
    expect(session.updatedAt.toISOString()).toBe('2026-04-15T10:00:02.000Z');
    expect(session.gitSha).toBe('1234567890abcdef');
    expect(context.toolSummaries.find((summary) => summary.name === 'task')).toBeUndefined();
    expect(context.sessionNotes?.lifecycle?.map((entry) => entry.type)).toEqual(['task_started', 'turn_aborted']);
    expect(context.sessionNotes?.lifecycle?.[0].metadata).toMatchObject({
      started_at: 1776077875,
      model_context_window: 200000,
      collaboration_mode_kind: 'default',
    });
    expect(context.sessionNotes?.lifecycle?.[1].metadata).toMatchObject({
      reason: 'interrupted',
      completed_at: 1776077876,
      duration_ms: 47,
    });
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      sessionTimestamp: '2026-04-15T09:59:58.500Z',
      rolloutTimestamp: '2026-04-15T10:00:00.000Z',
      source: 'vscode',
      originator: 'codex_cli_rs',
      cliVersion: '0.99.0',
      modelProvider: 'openai',
    });
    expect(context.markdown).toContain('Lifecycle task_started');
    expect(context.markdown).not.toContain('### Task');
  });

  it('falls back to git.sha when commit_hash is absent (covers both UnifiedSession and SessionNotes.sourceMetadata)', async () => {
    const home = makeCodexHome();
    const originalPath = writeRollout(
      home,
      path.join('sessions', '2026', '04', '15'),
      'rollout-2026-04-15T11-00-00-shaonly-session-id.jsonl',
      [
        {
          timestamp: '2026-04-15T11:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'shaonly-session-id',
            cwd: '/tmp/project',
            git: {
              branch: 'main',
              repository_url: 'https://github.com/user/project.git',
              sha: 'fedcba0987654321',
            },
          },
        },
        {
          timestamp: '2026-04-15T11:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'hello' },
        },
      ],
    );

    const { parseCodexSessions, extractCodexContext } = await loadCodexParser(home);
    const [session] = await parseCodexSessions();
    const context = await extractCodexContext(session);

    expect(originalPath).toContain('shaonly-session-id');
    expect(session.gitSha).toBe('fedcba0987654321');
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({ gitSha: 'fedcba0987654321' });
  });
});

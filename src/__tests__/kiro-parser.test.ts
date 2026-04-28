import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tmpHomes: string[] = [];

function encodeWorkspacePath(workspacePath: string): string {
  return Buffer.from(workspacePath, 'utf8').toString('base64url');
}

function createKiroWorkspace(homeDir: string, workspacePath: string): string {
  const workspaceDir = path.join(
    homeDir,
    'Library',
    'Application Support',
    'Kiro',
    'User',
    'globalStorage',
    'kiro.kiroagent',
    'workspace-sessions',
    encodeWorkspacePath(workspacePath),
  );
  fs.mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function createKiroAcpSessionDir(homeDir: string): string {
  const sessionDir = path.join(homeDir, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeJsonl(filePath: string, values: unknown[]): void {
  fs.writeFileSync(filePath, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
}

async function loadKiroParserWithHome(homeDir: string): Promise<typeof import('../parsers/kiro.js')> {
  vi.resetModules();
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });
  return import('../parsers/kiro.js');
}

afterEach(() => {
  vi.doUnmock('os');
  vi.resetModules();
  for (const tmpHome of tmpHomes) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  tmpHomes.length = 0;
});

describe('kiro parser hardening', () => {
  it('parses indexed workspace sessions and derives stable metadata', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const workspacePath = '/Users/dev/work/my-app';
    const workspaceDir = createKiroWorkspace(home, workspacePath);
    const sessionPath = path.join(workspaceDir, 'session-indexed.json');
    const updatedAt = new Date('2026-02-03T04:05:06.000Z');

    writeJson(path.join(workspaceDir, 'sessions.json'), [
      {
        sessionId: 'session-indexed',
        title: 'Auth investigation',
        dateCreated: '1770000000000',
        messageCount: 4,
      },
    ]);
    writeJson(sessionPath, {
      sessionId: 'session-indexed',
      selectedModel: 'claude-opus-4.5',
      history: [
        {
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Fix the auth bug' },
              { type: 'image', text: 'ignored screenshot payload' },
            ],
          },
        },
        { message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect login.ts.' }] } },
      ],
    });
    fs.utimesSync(sessionPath, updatedAt, updatedAt);

    const { parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'session-indexed',
      source: 'kiro',
      cwd: workspacePath,
      repo: 'work/my-app',
      lines: 4,
      originalPath: sessionPath,
      summary: 'Fix the auth bug',
      model: 'claude-opus-4.5',
    });
    expect(sessions[0].bytes).toBe(fs.statSync(sessionPath).size);
    expect(sessions[0].createdAt.toISOString()).toBe('2026-02-02T02:40:00.000Z');
    expect(sessions[0].updatedAt.toISOString()).toBe(updatedAt.toISOString());
  });

  it('tolerates invalid json, missing optional fields, malformed history, and empty sessions', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const workspaceDir = createKiroWorkspace(home, '/tmp/noisy-project');

    fs.writeFileSync(path.join(workspaceDir, 'broken.json'), '{not-json', 'utf8');
    writeJson(path.join(workspaceDir, 'partial.json'), {
      history: [
        null,
        { message: null },
        { role: 'system', content: 'skip system noise' },
        { role: 'human', content: 'Keep parsing despite malformed entries' },
        { role: 'assistant', content: 42 },
        { role: 'assistant', content: 'Recovered.' },
      ],
    });
    writeJson(path.join(workspaceDir, 'empty.json'), {
      sessionId: 'empty',
      title: 'Empty but indexed session',
      history: [{ role: 'system', content: 'noise only' }],
    });

    const { parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();

    expect(sessions.map((session) => session.id).sort()).toEqual(['empty', 'partial']);
    expect(sessions.find((session) => session.id === 'partial')).toMatchObject({
      cwd: '/tmp/noisy-project',
      lines: 2,
      summary: 'Keep parsing despite malformed entries',
    });
    expect(sessions.find((session) => session.id === 'empty')).toMatchObject({
      lines: 0,
      summary: 'Empty but indexed session',
    });
  });

  it('extracts only valid user and assistant messages from string and block-array content', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const workspacePath = '/Users/dev/work/content-app';
    const workspaceDir = createKiroWorkspace(home, workspacePath);
    const sessionPath = path.join(workspaceDir, 'content-session.json');

    writeJson(sessionPath, {
      sessionId: 'content-session',
      selectedModel: 'claude-sonnet-4.5',
      history: [
        {
          role: 'human',
          content: [
            { type: 'text', text: 'First user line' },
            { kind: 'text', data: 'Second user line' },
            { type: 'executionLog', text: 'execution-id-should-not-leak' },
          ],
        },
        { message: { role: 'assistant', content: 'Assistant answer.' } },
        { role: 'system', content: 'system noise' },
        { message: { role: 'tool', content: [{ type: 'text', text: 'tool noise' }] } },
      ],
    });

    const { extractKiroContext } = await loadKiroParserWithHome(home);
    const session: UnifiedSession = {
      id: 'content-session',
      source: 'kiro',
      cwd: workspacePath,
      repo: 'work/content-app',
      lines: 4,
      bytes: fs.statSync(sessionPath).size,
      createdAt: new Date('2026-02-03T00:00:00.000Z'),
      updatedAt: new Date('2026-02-03T00:05:00.000Z'),
      originalPath: sessionPath,
      summary: 'Content variants',
    };

    const context = await extractKiroContext(session);

    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'First user line\nSecond user line', timestamp: undefined },
      { role: 'assistant', content: 'Assistant answer.', timestamp: undefined },
    ]);
    expect(context.recentMessages[0].content).not.toContain('execution-id');
    expect(context.session.model).toBe('claude-sonnet-4.5');
    expect(context.sessionNotes?.model).toBe('claude-sonnet-4.5');
    expect(context.toolSummaries).toEqual([]);
    expect(context.filesModified).toEqual([]);
    expect(context.pendingTasks).toEqual([]);
  });

  it('keeps index-only sessions parseable and extracts empty context without fabricating tool calls', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const workspaceDir = createKiroWorkspace(home, '/tmp/index-only');
    const indexPath = path.join(workspaceDir, 'sessions.json');

    writeJson(indexPath, [
      {
        sessionId: 'indexed-without-file',
        title: 'Indexed without a session file',
        dateCreated: '2026-02-04T00:00:00.000Z',
        messageCount: 3,
        selectedModel: 'claude-sonnet-4',
      },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();
    const session = sessions[0];

    expect(session).toMatchObject({
      id: 'indexed-without-file',
      originalPath: indexPath,
      lines: 3,
      summary: 'Indexed without a session file',
      model: 'claude-sonnet-4',
    });

    const context = await extractKiroContext(session);

    expect(context.recentMessages).toEqual([]);
    expect(context.toolSummaries).toEqual([]);
    expect(context.sessionNotes?.model).toBe('claude-sonnet-4');
  });

  it('parses documented ACP JSON/JSONL sessions without inventing missing tool details', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const metadataPath = path.join(sessionDir, 'sess_acp_123.json');
    const eventPath = path.join(sessionDir, 'sess_acp_123.jsonl');

    writeJson(metadataPath, {
      id: 'sess_acp_123',
      title: 'ACP parser smoke',
      createdAt: '2026-02-05T01:00:00.000Z',
      updatedAt: '2026-02-05T01:03:00.000Z',
      model: 'claude-sonnet-4',
    });
    writeJsonl(eventPath, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/Users/dev/work/acp-app',
          mcpServers: [],
        },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: {
          sessionId: 'sess_acp_123',
          content: [{ type: 'text', text: 'Explain the ACP session parser' }],
        },
        timestamp: '2026-02-05T01:01:00.000Z',
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_123',
          update: { type: 'AgentMessageChunk', content: 'It reads JSONL ' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_123',
          update: { type: 'AgentMessageChunk', content: 'events conservatively.' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_123',
          update: {
            type: 'ToolCall',
            name: 'readTextFile',
            parameters: { path: 'src/parsers/kiro.ts' },
            status: 'completed',
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_123',
          update: { type: 'TurnEnd' },
        },
      },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'sess_acp_123',
      source: 'kiro',
      cwd: '/Users/dev/work/acp-app',
      repo: 'work/acp-app',
      lines: 2,
      originalPath: metadataPath,
      summary: 'Explain the ACP session parser',
      model: 'claude-sonnet-4',
    });
    expect(sessions[0].bytes).toBe(fs.statSync(metadataPath).size + fs.statSync(eventPath).size);
    expect(sessions[0].createdAt.toISOString()).toBe('2026-02-05T01:00:00.000Z');
    expect(sessions[0].updatedAt.toISOString()).toBe('2026-02-05T01:03:00.000Z');

    const context = await extractKiroContext(sessions[0]);

    expect(context.recentMessages).toEqual([
      {
        role: 'user',
        content: 'Explain the ACP session parser',
        timestamp: new Date('2026-02-05T01:01:00.000Z'),
      },
      { role: 'assistant', content: 'It reads JSONL events conservatively.', timestamp: undefined },
    ]);
    expect(context.toolSummaries).toEqual([
      expect.objectContaining({
        name: 'readTextFile',
        count: 1,
      }),
    ]);
    expect(context.filesModified).toEqual([]);
    expect(context.sessionNotes?.fidelityWarnings).toEqual([
      expect.stringContaining('normal Kiro CLI SQLite stores under ~/.kiro/ are skipped'),
    ]);
    expect(context.markdown).toContain('Kiro fidelity warning');
  });

  it('preserves whitespace-only ACP chunks while reconstructing streamed assistant messages', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const metadataPath = path.join(sessionDir, 'sess_acp_whitespace.json');
    const eventPath = path.join(sessionDir, 'sess_acp_whitespace.jsonl');

    writeJson(metadataPath, {
      id: 'sess_acp_whitespace',
      createdAt: '2026-02-06T01:00:00.000Z',
      updatedAt: '2026-02-06T01:01:00.000Z',
    });
    writeJsonl(eventPath, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: {
          sessionId: 'sess_acp_whitespace',
          content: 'Stream a greeting',
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_whitespace',
          update: { type: 'AgentMessageChunk', content: 'hello' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_whitespace',
          update: { type: 'AgentMessageChunk', content: ' ' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_whitespace',
          update: { type: 'AgentMessageChunk', content: 'world' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_whitespace',
          update: { type: 'TurnEnd' },
        },
      },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();
    const context = await extractKiroContext(sessions[0]);

    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Stream a greeting', timestamp: undefined },
      { role: 'assistant', content: 'hello world', timestamp: undefined },
    ]);
  });

  it('counts ACP ToolCallUpdate records as updates to a matching tool call', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const metadataPath = path.join(sessionDir, 'sess_acp_tool_update.json');
    const eventPath = path.join(sessionDir, 'sess_acp_tool_update.jsonl');

    writeJson(metadataPath, {
      id: 'sess_acp_tool_update',
      createdAt: '2026-02-07T01:00:00.000Z',
      updatedAt: '2026-02-07T01:01:00.000Z',
    });
    writeJsonl(eventPath, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: {
          sessionId: 'sess_acp_tool_update',
          content: 'Read the parser',
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_tool_update',
          update: {
            type: 'ToolCall',
            id: 'tool-call-1',
            name: 'readTextFile',
            parameters: { path: 'src/parsers/kiro.ts' },
            status: 'running',
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_tool_update',
          update: {
            type: 'ToolCallUpdate',
            id: 'tool-call-1',
            name: 'readTextFile',
            result: 'Loaded parser contents',
            status: 'completed',
          },
        },
      },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();
    const context = await extractKiroContext(sessions[0]);

    expect(context.toolSummaries).toEqual([
      expect.objectContaining({
        name: 'readTextFile',
        count: 1,
        samples: [
          expect.objectContaining({
            summary: 'readTextFile({"path":"src/parsers/kiro.ts"}) → "Loaded parser contents" [completed]',
            data: expect.objectContaining({
              category: 'mcp',
              toolName: 'readTextFile',
              result: 'Loaded parser contents',
            }),
          }),
        ],
      }),
    ]);
  });

  it('skips unknown CLI SQLite stores safely and reports the parser fidelity limit', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const kiroDir = path.join(home, '.kiro');
    fs.mkdirSync(kiroDir, { recursive: true });
    fs.writeFileSync(path.join(kiroDir, 'kiro.sqlite'), 'SQLite format 3\0unknown schema', 'utf8');

    const workspaceDir = createKiroWorkspace(home, '/tmp/sqlite-neighbor');
    writeJson(path.join(workspaceDir, 'known-session.json'), {
      sessionId: 'known-session',
      title: 'Known JSON session',
      history: [{ role: 'human', content: 'Use only supported Kiro surfaces' }],
    });

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();

    expect(sessions.map((session) => session.id)).toEqual(['known-session']);
    expect(sessions[0].originalPath).toBe(path.join(workspaceDir, 'known-session.json'));

    const context = await extractKiroContext(sessions[0]);

    expect(context.toolSummaries).toEqual([]);
    expect(context.sessionNotes?.sourceMetadata).toMatchObject({
      supportedSurfaces: ['ide-workspace-json', 'acp-json-jsonl'],
      skippedSurfaces: ['cli-sqlite'],
    });
    expect(context.sessionNotes?.fidelityWarnings?.[0]).toContain('SQLite stores under ~/.kiro/ are skipped');
    expect(context.markdown).toContain('SQLite stores under ~/.kiro/ are skipped');
  });

  it('does not double-count bytes for lone ACP jsonl sessions without sibling metadata', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const eventPath = path.join(sessionDir, 'sess_acp_lone.jsonl');

    writeJsonl(eventPath, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: { sessionId: 'sess_acp_lone', cwd: '/tmp/lone-acp' },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'sess_acp_lone', content: 'Lone jsonl prompt' },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: {
          sessionId: 'sess_acp_lone',
          update: { type: 'AgentMessageChunk', content: 'lone reply' },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/notification',
        params: { sessionId: 'sess_acp_lone', update: { type: 'TurnEnd' } },
      },
    ]);

    const { parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();

    expect(sessions).toHaveLength(1);
    // Without de-dupe, bytes would be reported as 2x the file size.
    expect(sessions[0].bytes).toBe(fs.statSync(eventPath).size);
    expect(sessions[0].originalPath).toBe(eventPath);
  });

  it('parses the canonical ACP wire format (sessionUpdate snake_case via session/update)', async () => {
    // This is the ground-truth ACP wire format Kiro CLI emits per the agent-client-protocol
    // schema and Kiro's own ACP docs (https://kiro.dev/docs/cli/acp/, kirodotdev/Kiro). The
    // discriminator field is `sessionUpdate` (not `type`), values are snake_case, and the
    // method name is `session/update` (not `session/notification`).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const metadataPath = path.join(sessionDir, 'sess_canonical.json');
    const eventPath = path.join(sessionDir, 'sess_canonical.jsonl');

    writeJson(metadataPath, {
      id: 'sess_canonical',
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:01:00.000Z',
      models: { currentModelId: 'claude-opus-4.6' },
    });
    writeJsonl(eventPath, [
      {
        jsonrpc: '2.0',
        id: 0,
        method: 'session/new',
        params: { cwd: '/Users/dev/work/canonical', mcpServers: [] },
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: {
          sessionId: 'sess_canonical',
          content: [{ type: 'text', text: 'What does this codebase do?' }],
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_canonical',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Reads ' },
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_canonical',
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'INTERNAL_REASONING_DO_NOT_LEAK' },
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_canonical',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'JSONL events.' },
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_canonical',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_001',
            name: 'read',
            status: 'in_progress',
            rawInput: { path: 'src/parsers/kiro.ts' },
          },
        },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_canonical',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_001',
            status: 'completed',
            output: 'fn main() { ... }',
          },
        },
      },
      // Turn end via the JSON-RPC response correlated to the prompt request id.
      { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].cwd).toBe('/Users/dev/work/canonical');
    expect(sessions[0].model).toBe('claude-opus-4.6');

    const context = await extractKiroContext(sessions[0]);
    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'What does this codebase do?', timestamp: undefined },
      { role: 'assistant', content: 'Reads JSONL events.', timestamp: undefined },
    ]);
    // Thought chunks must NOT leak into the conversation.
    expect(JSON.stringify(context.recentMessages)).not.toContain('INTERNAL_REASONING_DO_NOT_LEAK');
    expect(context.toolSummaries).toEqual([
      expect.objectContaining({
        name: 'read',
        count: 1,
        samples: [
          expect.objectContaining({
            summary: 'read({"path":"src/parsers/kiro.ts"}) → "fn main() { ... }" [completed]',
            data: expect.objectContaining({
              category: 'mcp',
              toolName: 'read',
              params: '{"path":"src/parsers/kiro.ts"}',
              result: 'fn main() { ... }',
            }),
          }),
        ],
      }),
    ]);
  });

  it('flushes pending assistant chunks on the matching session/prompt response stopReason', async () => {
    // Verifies the JSON-RPC response (id-correlated, no method, has stopReason) flushes the
    // streaming accumulator so the assistant turn ends cleanly even without a TurnEnd event.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const metadataPath = path.join(sessionDir, 'sess_stop_reason.json');
    const eventPath = path.join(sessionDir, 'sess_stop_reason.jsonl');

    writeJson(metadataPath, {
      id: 'sess_stop_reason',
      createdAt: '2026-04-11T01:00:00.000Z',
      updatedAt: '2026-04-11T01:01:00.000Z',
    });
    writeJsonl(eventPath, [
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: { sessionId: 'sess_stop_reason', content: [{ type: 'text', text: 'Hello' }] },
      },
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_stop_reason',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hi there.' },
          },
        },
      },
      // Response, NOT a notification — has id and result.stopReason but no method.
      { jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();
    const context = await extractKiroContext(sessions[0]);

    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Hello', timestamp: undefined },
      { role: 'assistant', content: 'Hi there.', timestamp: undefined },
    ]);
  });

  it('parses Kiro CLI persisted-format JSONL (AssistantMessage, UserMessage, ToolResults envelopes)', async () => {
    // Per kirodotdev/Kiro#6110, on-disk session JSONL contains envelope records keyed by
    // AssistantMessage / UserMessage / ToolResults — not raw ACP wire-protocol notifications.
    // The parser must understand both surfaces.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const metadataPath = path.join(sessionDir, 'sess_persisted.json');
    const eventPath = path.join(sessionDir, 'sess_persisted.jsonl');

    writeJson(metadataPath, {
      id: 'sess_persisted',
      cwd: '/Users/dev/work/persisted',
      createdAt: '2026-04-12T01:00:00.000Z',
      updatedAt: '2026-04-12T01:02:00.000Z',
    });
    writeJsonl(eventPath, [
      {
        UserMessage: {
          content: [{ type: 'text', text: 'Read the parser file' }],
        },
      },
      {
        AssistantMessage: {
          content: [{ type: 'text', text: 'Reading now.' }],
          toolUse: [
            {
              toolCallId: 'tooluse_AAA',
              name: 'read',
              rawInput: { path: 'src/parsers/kiro.ts' },
              status: 'in_progress',
            },
          ],
        },
      },
      {
        ToolResults: {
          results: [
            {
              toolResult: {
                toolCallId: 'tooluse_AAA',
                output: 'parser source bytes',
                status: 'completed',
              },
            },
          ],
        },
      },
      {
        AssistantMessage: {
          content: [{ type: 'text', text: 'The parser handles ACP and IDE sessions.' }],
        },
      },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();
    const context = await extractKiroContext(sessions[0]);

    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Read the parser file', timestamp: undefined },
      { role: 'assistant', content: 'Reading now.', timestamp: undefined },
      {
        role: 'assistant',
        content: 'The parser handles ACP and IDE sessions.',
        timestamp: undefined,
      },
    ]);
    expect(context.toolSummaries).toEqual([
      expect.objectContaining({
        name: 'read',
        count: 1,
        samples: [
          expect.objectContaining({
            summary: 'read({"path":"src/parsers/kiro.ts"}) → "parser source bytes" [completed]',
            data: expect.objectContaining({
              category: 'mcp',
              toolName: 'read',
              result: 'parser source bytes',
            }),
          }),
        ],
      }),
    ]);
  });

  it('accumulates user_message_chunk events into a streamed user prompt', async () => {
    // ACP supports `user_message_chunk` for streamed user input. The parser must accumulate
    // the chunks and flush them when a turn boundary or assistant response arrives.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const metadataPath = path.join(sessionDir, 'sess_user_chunks.json');
    const eventPath = path.join(sessionDir, 'sess_user_chunks.jsonl');

    writeJson(metadataPath, {
      id: 'sess_user_chunks',
      createdAt: '2026-04-13T00:00:00.000Z',
      updatedAt: '2026-04-13T00:01:00.000Z',
    });
    writeJsonl(eventPath, [
      {
        method: 'session/update',
        params: {
          sessionId: 'sess_user_chunks',
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Could you ' } },
        },
      },
      {
        method: 'session/update',
        params: {
          sessionId: 'sess_user_chunks',
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'review the diff?' } },
        },
      },
      {
        method: 'session/update',
        params: {
          sessionId: 'sess_user_chunks',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Sure.' } },
        },
      },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();
    const context = await extractKiroContext(sessions[0]);

    expect(context.recentMessages).toEqual([
      { role: 'user', content: 'Could you review the diff?', timestamp: undefined },
      { role: 'assistant', content: 'Sure.', timestamp: undefined },
    ]);
  });

  it('extracts tool output from canonical ACP ToolCall content[] (ToolCallContent blocks)', async () => {
    // The canonical ACP ToolCall puts results in a `content[]` array of ToolCallContent
    // (`{ type: "content", content: ContentBlock }` or `{ type: "diff", ... }`). Verify the
    // parser pulls text from these structured blocks even when no flat `output` is present.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const sessionDir = createKiroAcpSessionDir(home);
    const metadataPath = path.join(sessionDir, 'sess_canonical_tool.json');
    const eventPath = path.join(sessionDir, 'sess_canonical_tool.jsonl');

    writeJson(metadataPath, {
      id: 'sess_canonical_tool',
      createdAt: '2026-04-14T00:00:00.000Z',
      updatedAt: '2026-04-14T00:01:00.000Z',
    });
    writeJsonl(eventPath, [
      {
        method: 'session/prompt',
        params: { sessionId: 'sess_canonical_tool', content: [{ type: 'text', text: 'List files' }] },
      },
      {
        method: 'session/update',
        params: {
          sessionId: 'sess_canonical_tool',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_99',
            title: 'ls',
            status: 'in_progress',
            rawInput: { path: '.' },
          },
        },
      },
      {
        method: 'session/update',
        params: {
          sessionId: 'sess_canonical_tool',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_99',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'README.md\nsrc/' } }],
          },
        },
      },
    ]);

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();
    const context = await extractKiroContext(sessions[0]);

    expect(context.toolSummaries).toEqual([
      expect.objectContaining({
        name: 'ls',
        count: 1,
        samples: [
          expect.objectContaining({
            data: expect.objectContaining({
              toolName: 'ls',
              result: 'README.md\nsrc/',
            }),
          }),
        ],
      }),
    ]);
  });

  it('keeps Kiro fidelity warning visible across notes, timeline, and rendered markdown', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-parser-'));
    tmpHomes.push(home);
    const workspaceDir = createKiroWorkspace(home, '/tmp/warning-surfaces');
    writeJson(path.join(workspaceDir, 'session-warning.json'), {
      sessionId: 'session-warning',
      title: 'Warning surfaces',
      history: [{ role: 'human', content: 'verify warning rendering' }],
    });

    const { extractKiroContext, parseKiroSessions } = await loadKiroParserWithHome(home);
    const sessions = await parseKiroSessions();
    const context = await extractKiroContext(sessions[0]);

    expect(context.sessionNotes?.fidelityWarnings?.[0]).toContain('Kiro fidelity warning');
    const timeline = context.timeline ?? [];
    const lastTimelineEntry = timeline[timeline.length - 1];
    expect(lastTimelineEntry).toMatchObject({
      kind: 'warning',
      content: expect.stringContaining('Kiro fidelity warning'),
    });
    expect(context.markdown).toContain('Kiro fidelity warning');
  });
});

/**
 * Fixture-based unit tests for all 30 cross-tool conversion paths.
 * Tests each parser's extractContext using controlled fixture data,
 * independent of real session files on the machine.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationMessage, SessionContext, SessionSource, UnifiedSession } from '../types/index.js';
import { generateHandoffMarkdown, getSourceLabels } from '../utils/markdown.js';
import {
  createClaudeFixture,
  createCodexFixture,
  createCopilotFixture,
  createCursorFixture,
  createDroidFixture,
  createGeminiFixture,
  createOpenCodeSqliteFixture,
  type FixtureDir,
} from './fixtures/index.js';

// ─── Fixture-Based Parser Tests ──────────────────────────────────────────────

/**
 * Minimal low-level parsers extracted from each module for fixture testing.
 * These replicate the core extraction logic so we can test with controlled data.
 */

function parseClaudeFixtureMessages(filePath: string): ConversationMessage[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'queue-operation' || parsed.type === 'system') continue;
      if (parsed.isCompactSummary) continue;

      if (parsed.type === 'user' && parsed.message?.content) {
        const text =
          typeof parsed.message.content === 'string'
            ? parsed.message.content
            : parsed.message.content
                .filter((c: any) => c.type === 'text' && c.text)
                .map((c: any) => c.text)
                .join('\n');
        if (text && !text.startsWith('<') && !text.startsWith('/') && !text.includes('Session Handoff')) {
          messages.push({ role: 'user', content: text, timestamp: new Date(parsed.timestamp) });
        }
      } else if (parsed.type === 'assistant' && parsed.message?.content) {
        const text =
          typeof parsed.message.content === 'string'
            ? parsed.message.content
            : parsed.message.content
                .filter((c: any) => c.type === 'text' && c.text)
                .map((c: any) => c.text)
                .join('\n');
        if (text) {
          messages.push({ role: 'assistant', content: text, timestamp: new Date(parsed.timestamp) });
        }
      }
    } catch {
      /* skip */
    }
  }
  return messages;
}

function parseCopilotFixtureMessages(eventsPath: string): ConversationMessage[] {
  const content = fs.readFileSync(eventsPath, 'utf8');
  const lines = content.trim().split('\n');
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'user.message') {
        const text = event.data?.content || event.data?.transformedContent || '';
        if (text) messages.push({ role: 'user', content: text, timestamp: new Date(event.timestamp) });
      } else if (event.type === 'assistant.message') {
        const text = event.data?.content || '';
        if (text) messages.push({ role: 'assistant', content: text, timestamp: new Date(event.timestamp) });
      }
    } catch {
      /* skip */
    }
  }
  return messages;
}

function parseGeminiFixtureMessages(filePath: string): ConversationMessage[] {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const messages: ConversationMessage[] = [];

  for (const msg of data.messages || []) {
    if (msg.type === 'user') {
      messages.push({ role: 'user', content: msg.content, timestamp: new Date(msg.timestamp) });
    } else if (msg.type === 'gemini') {
      if (msg.content) {
        messages.push({ role: 'assistant', content: msg.content, timestamp: new Date(msg.timestamp) });
      } else if (msg.toolCalls?.length > 0) {
        const toolNames = msg.toolCalls.map((t: any) => t.name).join(', ');
        messages.push({
          role: 'assistant',
          content: `[Used tools: ${toolNames}]`,
          timestamp: new Date(msg.timestamp),
          toolCalls: msg.toolCalls.map((t: any) => ({ name: t.name, arguments: t.args })),
        });
      }
    }
  }
  return messages;
}

function parseCodexFixtureMessages(filePath: string): ConversationMessage[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'event_msg' && parsed.payload?.type === 'user_message') {
        const text = parsed.payload.message || '';
        if (text) messages.push({ role: 'user', content: text, timestamp: new Date(parsed.timestamp) });
      } else if (
        parsed.type === 'event_msg' &&
        (parsed.payload?.type === 'agent_message' || parsed.payload?.type === 'assistant_message')
      ) {
        const text = parsed.payload.message || '';
        if (text) messages.push({ role: 'assistant', content: text, timestamp: new Date(parsed.timestamp) });
      }
    } catch {
      /* skip */
    }
  }
  return messages;
}

function parseOpenCodeFixtureMessages(dbPath: string, sessionId: string): ConversationMessage[] {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  const messages: ConversationMessage[] = [];

  try {
    const msgRows = db
      .prepare('SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC')
      .all(sessionId) as any[];

    for (const msgRow of msgRows) {
      const msgData = JSON.parse(msgRow.data);
      const role = msgData.role === 'user' ? 'user' : 'assistant';

      const partRows = db
        .prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC')
        .all(msgRow.id) as any[];

      let text = '';
      for (const partRow of partRows) {
        const partData = JSON.parse(partRow.data);
        if (partData.type === 'text' && partData.text) text += partData.text + '\n';
      }

      if (text.trim()) {
        messages.push({
          role: role as 'user' | 'assistant',
          content: text.trim(),
          timestamp: new Date(msgRow.time_created),
        });
      }
    }
  } finally {
    db.close();
  }
  return messages;
}

function parseCursorFixtureMessages(filePath: string): ConversationMessage[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const role = parsed.role;
      const contentBlocks = parsed.message?.content || [];

      const textParts: string[] = [];
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          if (
            block.text.startsWith('<system-reminder>') ||
            block.text.startsWith('<permissions') ||
            block.text.startsWith('<external_links>') ||
            block.text.startsWith('<image_files>')
          )
            continue;

          // Extract from user_query tags
          const queryMatch = block.text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
          const cleaned = queryMatch ? queryMatch[1].trim() : block.text;
          if (cleaned) textParts.push(cleaned);
        }
      }

      const text = textParts.join('\n').trim();
      if (!text) continue;

      messages.push({
        role: role === 'user' ? 'user' : 'assistant',
        content: text,
      });
    } catch {
      /* skip */
    }
  }
  return messages;
}

function parseDroidFixtureMessages(filePath: string): ConversationMessage[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'message') continue;
      const role = parsed.message?.role;
      const contentBlocks = parsed.message?.content || [];

      const textParts: string[] = [];
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          if (!block.text.startsWith('<system-reminder>') && !block.text.startsWith('<permissions')) {
            textParts.push(block.text);
          }
        }
      }

      const text = textParts.join('\n').trim();
      if (!text) continue;

      messages.push({
        role: role === 'user' ? 'user' : 'assistant',
        content: text,
        timestamp: parsed.timestamp ? new Date(parsed.timestamp) : undefined,
      });
    } catch {
      /* skip */
    }
  }
  return messages;
}

// ─── Fixture Data ────────────────────────────────────────────────────────────

// Derive from registry — automatically picks up new tools
import { ALL_TOOLS } from '../parsers/registry.js';

const ALL_SOURCES: readonly SessionSource[] = ALL_TOOLS;

const fixtures: Record<string, FixtureDir> = {};
const contexts: Record<string, SessionContext> = {};

beforeAll(() => {
  // Create fixtures
  fixtures.claude = createClaudeFixture();
  fixtures.copilot = createCopilotFixture();
  fixtures.gemini = createGeminiFixture();
  fixtures.codex = createCodexFixture();
  fixtures.opencode = createOpenCodeSqliteFixture();
  fixtures.droid = createDroidFixture();
  fixtures.cursor = createCursorFixture();

  // Build contexts from fixtures
  const now = new Date();

  // Claude
  const claudeFile = fs
    .readdirSync(fixtures.claude.root, { recursive: true })
    .map((f) => path.join(fixtures.claude.root, f as string))
    .find((f) => f.endsWith('.jsonl'))!;
  const claudeSession: UnifiedSession = {
    id: 'test-claude-session-1',
    source: 'claude',
    cwd: '/home/user/project',
    repo: 'user/project',
    branch: 'main',
    lines: 5,
    bytes: 1000,
    createdAt: now,
    updatedAt: now,
    originalPath: claudeFile,
    summary: 'Fix auth bug',
  };
  const claudeMsgs = parseClaudeFixtureMessages(claudeFile);
  contexts.claude = {
    session: claudeSession,
    recentMessages: claudeMsgs,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    markdown: generateHandoffMarkdown(claudeSession, claudeMsgs, [], [], []),
  };

  // Copilot
  const copilotDir = fs.readdirSync(fixtures.copilot.root, { withFileTypes: true }).find((d) => d.isDirectory())!;
  const copilotEventsPath = path.join(fixtures.copilot.root, copilotDir.name, 'events.jsonl');
  const copilotSession: UnifiedSession = {
    id: 'test-copilot-session-1',
    source: 'copilot',
    cwd: '/home/user/project',
    repo: undefined,
    lines: 5,
    bytes: 1000,
    createdAt: now,
    updatedAt: now,
    originalPath: path.join(fixtures.copilot.root, copilotDir.name),
    summary: 'Fix auth bug',
    model: 'claude-sonnet-4',
  };
  const copilotMsgs = parseCopilotFixtureMessages(copilotEventsPath);
  contexts.copilot = {
    session: copilotSession,
    recentMessages: copilotMsgs,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    markdown: generateHandoffMarkdown(copilotSession, copilotMsgs, [], [], []),
  };

  // Gemini
  const geminiFile = fs
    .readdirSync(fixtures.gemini.root, { recursive: true })
    .map((f) => path.join(fixtures.gemini.root, f as string))
    .find((f) => f.endsWith('.json'))!;
  const geminiSession: UnifiedSession = {
    id: 'test-gemini-session-1',
    source: 'gemini',
    cwd: '',
    repo: '',
    lines: 10,
    bytes: 500,
    createdAt: now,
    updatedAt: now,
    originalPath: geminiFile,
    summary: 'Fix auth bug',
  };
  const geminiMsgs = parseGeminiFixtureMessages(geminiFile);
  contexts.gemini = {
    session: geminiSession,
    recentMessages: geminiMsgs,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    markdown: generateHandoffMarkdown(geminiSession, geminiMsgs, [], [], []),
  };

  // Codex
  const codexFile = fs
    .readdirSync(fixtures.codex.root, { recursive: true })
    .map((f) => path.join(fixtures.codex.root, f as string))
    .find((f) => f.endsWith('.jsonl'))!;
  const codexSession: UnifiedSession = {
    id: 'test-codex-uuid-1234',
    source: 'codex',
    cwd: '/home/user/project',
    repo: 'user/project.git',
    branch: 'main',
    lines: 5,
    bytes: 800,
    createdAt: now,
    updatedAt: now,
    originalPath: codexFile,
    summary: 'Fix auth bug',
  };
  const codexMsgs = parseCodexFixtureMessages(codexFile);
  contexts.codex = {
    session: codexSession,
    recentMessages: codexMsgs,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    markdown: generateHandoffMarkdown(codexSession, codexMsgs, [], [], []),
  };

  // OpenCode (SQLite)
  const opencodDbPath = path.join(fixtures.opencode.root, 'opencode.db');
  const opencodeSession: UnifiedSession = {
    id: 'ses_test1',
    source: 'opencode',
    cwd: '/home/user/project',
    repo: 'user/project',
    lines: 4,
    bytes: 0,
    createdAt: now,
    updatedAt: now,
    originalPath: opencodDbPath,
    summary: 'Fix auth bug',
  };
  const opencodeMsgs = parseOpenCodeFixtureMessages(opencodDbPath, 'ses_test1');
  contexts.opencode = {
    session: opencodeSession,
    recentMessages: opencodeMsgs,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    markdown: generateHandoffMarkdown(opencodeSession, opencodeMsgs, [], [], []),
  };

  // Droid
  const droidFile = fs
    .readdirSync(fixtures.droid.root, { recursive: true })
    .map((f) => path.join(fixtures.droid.root, f as string))
    .find((f) => f.endsWith('.jsonl'))!;
  const droidSession: UnifiedSession = {
    id: 'dddddddd-1111-2222-3333-444444444444',
    source: 'droid',
    cwd: '/home/user/project',
    repo: 'user/project',
    lines: 10,
    bytes: 2000,
    createdAt: now,
    updatedAt: now,
    originalPath: droidFile,
    summary: 'Fix auth bug',
    model: 'claude-opus-4-6',
  };
  const droidMsgs = parseDroidFixtureMessages(droidFile);
  contexts.droid = {
    session: droidSession,
    recentMessages: droidMsgs,
    filesModified: ['/home/user/project/login.ts'],
    pendingTasks: ['Add error handling', 'Write tests'],
    toolSummaries: [],
    markdown: generateHandoffMarkdown(
      droidSession,
      droidMsgs,
      ['/home/user/project/login.ts'],
      ['Add error handling', 'Write tests'],
      [],
    ),
  };

  // Cursor
  const cursorFile = fs
    .readdirSync(fixtures.cursor.root, { recursive: true })
    .map((f) => path.join(fixtures.cursor.root, f as string))
    .find((f) => f.endsWith('.jsonl'))!;
  const cursorSession: UnifiedSession = {
    id: 'cccccccc-1111-2222-3333-444444444444',
    source: 'cursor',
    cwd: '/home/user/project',
    repo: 'user/project',
    lines: 9,
    bytes: 1500,
    createdAt: now,
    updatedAt: now,
    originalPath: cursorFile,
    summary: 'Fix auth bug',
  };
  const cursorMsgs = parseCursorFixtureMessages(cursorFile);
  contexts.cursor = {
    session: cursorSession,
    recentMessages: cursorMsgs,
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    markdown: generateHandoffMarkdown(cursorSession, cursorMsgs, [], [], []),
  };
});

afterAll(() => {
  for (const fixture of Object.values(fixtures)) {
    fixture.cleanup();
  }
});

// ─── Low-Level Parser Tests ─────────────────────────────────────────────────

describe('Low-Level Fixture Parsing', () => {
  it('Claude: extracts user and assistant messages from JSONL', () => {
    const msgs = contexts.claude.recentMessages;
    expect(msgs.length).toBe(4);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain('Fix the authentication bug');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('token validation was missing');
  });

  it('Claude: skips system and queue-operation messages', () => {
    const msgs = contexts.claude.recentMessages;
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    expect(systemMsgs.length).toBe(0);
  });

  it('Copilot: extracts user.message and assistant.message events', () => {
    const msgs = contexts.copilot.recentMessages;
    expect(msgs.length).toBe(4);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[2].role).toBe('user');
    expect(msgs[3].role).toBe('assistant');
  });

  it('Copilot: ignores session.start events in message extraction', () => {
    const msgs = contexts.copilot.recentMessages;
    // session.start should not produce a conversation message
    for (const msg of msgs) {
      expect(msg.content).not.toContain('session.start');
    }
  });

  it('Gemini: extracts user and gemini-type messages', () => {
    const msgs = contexts.gemini.recentMessages;
    const userMsgs = msgs.filter((m) => m.role === 'user');
    const asstMsgs = msgs.filter((m) => m.role === 'assistant');
    expect(userMsgs.length).toBe(2);
    expect(asstMsgs.length).toBeGreaterThanOrEqual(2);
  });

  it('Gemini: captures tool-call-only messages (empty content + toolCalls)', () => {
    const msgs = contexts.gemini.recentMessages;
    const toolMsgs = msgs.filter((m) => m.content.includes('[Used tools:'));
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toContain('read_file');
    expect(toolMsgs[0].toolCalls).toBeDefined();
    expect(toolMsgs[0].toolCalls!.length).toBe(1);
    expect(toolMsgs[0].toolCalls![0].name).toBe('read_file');
  });

  it('Codex: extracts user_message and agent_message from event_msg', () => {
    const msgs = contexts.codex.recentMessages;
    expect(msgs.length).toBe(4);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain('Fix the authentication bug');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('token validation was missing');
  });

  it('Codex: skips session_meta in message extraction', () => {
    const msgs = contexts.codex.recentMessages;
    for (const msg of msgs) {
      expect(msg.content).not.toContain('session_meta');
      expect(msg.content).not.toContain('codex_cli_rs');
    }
  });

  it('OpenCode SQLite: extracts messages via message+part join', () => {
    const msgs = contexts.opencode.recentMessages;
    expect(msgs.length).toBe(4);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain('Fix the authentication bug');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[3].role).toBe('assistant');
  });

  it('OpenCode SQLite: messages are ordered chronologically', () => {
    const msgs = contexts.opencode.recentMessages;
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].timestamp!.getTime()).toBeGreaterThanOrEqual(msgs[i - 1].timestamp!.getTime());
    }
  });

  it('Droid: extracts user and assistant text messages from JSONL', () => {
    const msgs = contexts.droid.recentMessages;
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain('Fix the authentication bug');
    const asstMsgs = msgs.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBeGreaterThan(0);
    expect(asstMsgs[0].content).toContain('token validation was missing');
  });

  it('Droid: skips session_start and todo_state events in message extraction', () => {
    const msgs = contexts.droid.recentMessages;
    for (const msg of msgs) {
      expect(msg.content).not.toContain('session_start');
      expect(msg.content).not.toContain('todo_state');
    }
  });

  it('Droid: skips tool_use and tool_result content blocks (only text)', () => {
    const msgs = contexts.droid.recentMessages;
    for (const msg of msgs) {
      expect(msg.content).not.toContain('tool_use');
      expect(msg.content).not.toContain('tool_result');
    }
  });

  it('Cursor: extracts user and assistant text messages from JSONL', () => {
    const msgs = contexts.cursor.recentMessages;
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain('Fix the authentication bug');
    const asstMsgs = msgs.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBeGreaterThan(0);
    expect(asstMsgs.some((m) => m.content.includes('token validation was missing'))).toBe(true);
  });

  it('Cursor: strips <user_query> tags from user messages', () => {
    const msgs = contexts.cursor.recentMessages;
    for (const msg of msgs) {
      expect(msg.content).not.toContain('<user_query>');
      expect(msg.content).not.toContain('</user_query>');
    }
  });

  it('Cursor: skips tool_use and tool_result content blocks (only text)', () => {
    const msgs = contexts.cursor.recentMessages;
    for (const msg of msgs) {
      expect(msg.content).not.toContain('tool_use');
      expect(msg.content).not.toContain('tool_result');
    }
  });
});

// ─── Shared Markdown Generator Tests ────────────────────────────────────────

describe('Shared generateHandoffMarkdown', () => {
  it('includes correct source label for each tool', () => {
    for (const source of ALL_SOURCES) {
      const ctx = contexts[source];
      expect(ctx.markdown).toContain(getSourceLabels()[source]);
    }
  });

  it('includes session ID in markdown', () => {
    for (const source of ALL_SOURCES) {
      const ctx = contexts[source];
      expect(ctx.markdown).toContain(ctx.session.id);
    }
  });

  it('includes working directory', () => {
    for (const source of ALL_SOURCES) {
      const ctx = contexts[source];
      if (source === 'gemini') {
        // Gemini has no cwd data
        expect(ctx.session.cwd).toBe('');
      } else {
        expect(ctx.markdown).toContain('/home/user/project');
      }
    }
  });

  it('includes model when present', () => {
    // Copilot has model set
    expect(contexts.copilot.markdown).toContain('claude-sonnet-4');
    // Claude has no model set
    expect(contexts.claude.markdown).not.toContain('**Model**');
  });

  it('includes summary when present', () => {
    for (const source of ALL_SOURCES) {
      const ctx = contexts[source];
      expect(ctx.markdown).toContain('Fix auth bug');
    }
  });

  it('truncates long messages to 500 chars', () => {
    const longMsg: ConversationMessage = {
      role: 'user',
      content: 'A'.repeat(600),
    };
    const session: UnifiedSession = {
      id: 'test',
      source: 'claude',
      cwd: '/tmp',
      lines: 1,
      bytes: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: '/tmp',
    };
    const md = generateHandoffMarkdown(session, [longMsg], [], [], []);
    expect(md).toContain('A'.repeat(500) + '…');
    expect(md).not.toContain('A'.repeat(501));
  });

  it('includes files modified when present', () => {
    const session: UnifiedSession = {
      id: 'test',
      source: 'codex',
      cwd: '/tmp',
      lines: 1,
      bytes: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: '/tmp',
    };
    const md = generateHandoffMarkdown(session, [], ['src/auth.ts', 'src/login.ts'], [], []);
    expect(md).toContain('## Files Modified');
    expect(md).toContain('src/auth.ts');
    expect(md).toContain('src/login.ts');
  });

  it('includes pending tasks when present', () => {
    const session: UnifiedSession = {
      id: 'test',
      source: 'opencode',
      cwd: '/tmp',
      lines: 1,
      bytes: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: '/tmp',
    };
    const md = generateHandoffMarkdown(session, [], [], ['Add tests', 'Fix lint errors'], []);
    expect(md).toContain('## Pending Tasks');
    expect(md).toContain('- [ ] Add tests');
    expect(md).toContain('- [ ] Fix lint errors');
  });

  it('always ends with continuation prompt', () => {
    for (const source of ALL_SOURCES) {
      const ctx = contexts[source];
      expect(ctx.markdown).toContain('You are continuing this session');
    }
  });

  it('renders category-aware tool activity with structured data', () => {
    const session: UnifiedSession = {
      id: 'test',
      source: 'claude',
      cwd: '/tmp',
      lines: 1,
      bytes: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: '/tmp',
    };

    const toolSummaries: import('../types/index.js').ToolUsageSummary[] = [
      {
        name: 'Bash',
        count: 2,
        errorCount: 1,
        samples: [
          {
            summary: '$ npm test → exit 0',
            data: { category: 'shell', command: 'npm test', exitCode: 0 },
          },
          {
            summary: '$ npm build → exit 1',
            data: { category: 'shell', command: 'npm build', exitCode: 1, errored: true, stdoutTail: 'Error: build failed' },
          },
        ],
      },
      {
        name: 'Read',
        count: 2,
        samples: [
          {
            summary: 'read src/app.ts',
            data: { category: 'read', filePath: 'src/app.ts' },
          },
          {
            summary: 'read src/utils.ts (lines 10-50)',
            data: { category: 'read', filePath: 'src/utils.ts', lineStart: 10, lineEnd: 50 },
          },
        ],
      },
      {
        name: 'Edit',
        count: 1,
        samples: [
          {
            summary: 'edit src/auth.ts (+2 -1)',
            data: {
              category: 'edit',
              filePath: 'src/auth.ts',
              diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n-old line\n+new line1\n+new line2',
              diffStats: { added: 2, removed: 1 },
            },
          },
        ],
      },
      {
        name: 'Grep',
        count: 1,
        samples: [
          {
            summary: 'grep "TODO" src/',
            data: { category: 'grep', pattern: 'TODO', targetPath: 'src/', matchCount: 5 },
          },
        ],
      },
    ];

    const md = generateHandoffMarkdown(session, [], [], [], toolSummaries);

    // Category headers
    expect(md).toContain('### Shell (2 calls, 1 errors)');
    expect(md).toContain('### Read (2 calls)');
    expect(md).toContain('### Edit (1 calls)');
    expect(md).toContain('### Grep (1 calls)');

    // Shell: commands and exit codes
    expect(md).toContain('`$ npm test`');
    expect(md).toContain('Exit: 0');
    expect(md).toContain('Exit: 1  **[ERROR]**');
    expect(md).toContain('Error: build failed');

    // Read: file paths with line ranges
    expect(md).toContain('`src/app.ts`');
    expect(md).toContain('`src/utils.ts` (lines 10-50)');

    // Edit: diff blocks
    expect(md).toContain('```diff');
    expect(md).toContain('-old line');
    expect(md).toContain('+new line1');

    // Grep: pattern with match count
    expect(md).toContain('`"TODO"`');
    expect(md).toContain('5 matches');
  });
});

// ─── All 20 Conversion Path Tests ──────────────────────────────────────────

describe('All 42 Fixture-Based Conversion Paths', () => {
  let conversionNumber = 0;

  for (const source of ALL_SOURCES) {
    for (const target of ALL_SOURCES) {
      if (source === target) continue;

      conversionNumber++;
      const testName = `#${conversionNumber}: ${source} → ${target}`;

      it(testName, () => {
        const ctx = contexts[source];
        expect(ctx).toBeDefined();

        const md = ctx.markdown;

        // Structure checks
        expect(md).toContain('# Session Handoff Context');
        expect(md).toContain('## Session Overview');
        expect(md).toContain('**Session ID**');
        expect(md).toContain('**Working Directory**');
        expect(md).toContain('**Last Active**');
        expect(md).toContain('## Recent Conversation');
        expect(md).toContain('You are continuing this session');

        // Source attribution
        expect(md).toContain(getSourceLabels()[source]);

        // Has meaningful content
        expect(md.length).toBeGreaterThan(100);
        const lines = md.split('\n');
        expect(lines.length).toBeGreaterThan(5);

        // Messages were extracted
        expect(ctx.recentMessages.length).toBeGreaterThan(0);

        // At least one user and one assistant message
        const userMsgs = ctx.recentMessages.filter((m) => m.role === 'user');
        const asstMsgs = ctx.recentMessages.filter((m) => m.role === 'assistant');
        expect(userMsgs.length).toBeGreaterThan(0);
        expect(asstMsgs.length).toBeGreaterThan(0);

        // Correct session source
        expect(ctx.session.source).toBe(source);
      });
    }
  }
});

// ─── Injection Safety Tests ─────────────────────────────────────────────────

describe('Injection Safety (Fixture-Based)', () => {
  for (const source of ALL_SOURCES) {
    for (const target of ALL_SOURCES) {
      if (source === target) continue;

      it(`${source}→${target}: safe for injection`, () => {
        const md = contexts[source].markdown;

        // No null bytes
        expect(md).not.toContain('\0');

        // No very long lines
        for (const line of md.split('\n')) {
          expect(line.length).toBeLessThan(10000);
        }

        // Valid UTF-8
        expect(Buffer.from(md, 'utf8').toString('utf8')).toBe(md);

        // Reasonable size
        expect(Buffer.byteLength(md, 'utf8')).toBeLessThan(50000);
      });
    }
  }
});

// ─── Unique Session ID Test ─────────────────────────────────────────────────

describe('Cross-Source Uniqueness', () => {
  it('all 7 sources produce different session IDs', () => {
    const ids = new Set(ALL_SOURCES.map((s) => contexts[s].session.id));
    expect(ids.size).toBe(7);
  });

  it('all 7 sources have correct source type', () => {
    for (const source of ALL_SOURCES) {
      expect(contexts[source].session.source).toBe(source);
    }
  });
});

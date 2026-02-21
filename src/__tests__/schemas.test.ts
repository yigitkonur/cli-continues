/**
 * Tests for Zod schemas in src/types/.
 * Covers content-blocks, tool-names, and all parser raw format schemas.
 */
import { describe, expect, it } from 'vitest';
import {
  ContentBlockSchema,
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolResultBlockSchema,
  ToolUseBlockSchema,
} from '../types/content-blocks.js';
import {
  ClaudeMessageSchema,
  CodexEventMsgSchema,
  CodexMessageSchema,
  CodexResponseItemSchema,
  CodexSessionMetaSchema,
  CodexTurnContextSchema,
  CopilotEventSchema,
  CopilotWorkspaceSchema,
  CursorTranscriptLineSchema,
  DroidCompactionStateSchema,
  DroidEventSchema,
  DroidMessageEventSchema,
  DroidSessionStartSchema,
  DroidSettingsSchema,
  DroidTodoStateSchema,
  GeminiMessageSchema,
  GeminiSessionSchema,
  GeminiToolCallSchema,
  OpenCodeMessageSchema,
  OpenCodeSessionSchema,
  SerializedSessionSchema,
  SqliteSessionRowSchema,
} from '../types/schemas.js';
import type { SessionSource } from '../types/tool-names.js';
import { EDIT_TOOLS, READ_TOOLS, SHELL_TOOLS, TOOL_NAMES, WRITE_TOOLS } from '../types/tool-names.js';

// ── tool-names.ts ────────────────────────────────────────────────────────────

describe('TOOL_NAMES', () => {
  it('contains exactly 7 tools', () => {
    expect(TOOL_NAMES).toHaveLength(7);
  });

  it('includes all known tools', () => {
    const expected: SessionSource[] = ['claude', 'codex', 'copilot', 'gemini', 'opencode', 'droid', 'cursor'];
    expect([...TOOL_NAMES]).toEqual(expected);
  });

  it('is frozen at runtime (immutable)', () => {
    expect(Object.isFrozen(TOOL_NAMES)).toBe(true);
  });
});

describe('Canonical tool name sets', () => {
  it('SHELL_TOOLS contains Bash and exec_command', () => {
    expect(SHELL_TOOLS.has('Bash')).toBe(true);
    expect(SHELL_TOOLS.has('exec_command')).toBe(true);
  });

  it('READ_TOOLS contains Read and read_file', () => {
    expect(READ_TOOLS.has('Read')).toBe(true);
    expect(READ_TOOLS.has('read_file')).toBe(true);
  });

  it('WRITE_TOOLS contains Write and create_file', () => {
    expect(WRITE_TOOLS.has('Write')).toBe(true);
    expect(WRITE_TOOLS.has('create_file')).toBe(true);
  });

  it('EDIT_TOOLS contains Edit and apply_diff', () => {
    expect(EDIT_TOOLS.has('Edit')).toBe(true);
    expect(EDIT_TOOLS.has('apply_diff')).toBe(true);
  });
});

// ── content-blocks.ts ────────────────────────────────────────────────────────

describe('ContentBlock schemas', () => {
  describe('TextBlockSchema', () => {
    it('accepts valid text block', () => {
      const result = TextBlockSchema.safeParse({ type: 'text', text: 'hello' });
      expect(result.success).toBe(true);
    });

    it('rejects missing text field', () => {
      const result = TextBlockSchema.safeParse({ type: 'text' });
      expect(result.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const result = TextBlockSchema.safeParse({ type: 'thinking', text: 'hello' });
      expect(result.success).toBe(false);
    });
  });

  describe('ThinkingBlockSchema', () => {
    it('accepts thinking block with text', () => {
      const result = ThinkingBlockSchema.safeParse({ type: 'thinking', text: 'reasoning...' });
      expect(result.success).toBe(true);
    });

    it('accepts thinking block with thinking field', () => {
      const result = ThinkingBlockSchema.safeParse({ type: 'thinking', thinking: 'deep thought' });
      expect(result.success).toBe(true);
    });

    it('accepts thinking block with no text (both optional)', () => {
      const result = ThinkingBlockSchema.safeParse({ type: 'thinking' });
      expect(result.success).toBe(true);
    });
  });

  describe('ToolUseBlockSchema', () => {
    it('accepts valid tool_use block', () => {
      const result = ToolUseBlockSchema.safeParse({
        type: 'tool_use',
        id: 'tu_123',
        name: 'Bash',
        input: { command: 'ls' },
      });
      expect(result.success).toBe(true);
    });

    it('defaults input to empty object when omitted', () => {
      const result = ToolUseBlockSchema.safeParse({
        type: 'tool_use',
        id: 'tu_123',
        name: 'Bash',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.input).toEqual({});
      }
    });

    it('rejects missing name', () => {
      const result = ToolUseBlockSchema.safeParse({
        type: 'tool_use',
        id: 'tu_123',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ToolResultBlockSchema', () => {
    it('accepts string content', () => {
      const result = ToolResultBlockSchema.safeParse({
        type: 'tool_result',
        tool_use_id: 'tu_123',
        content: 'output here',
      });
      expect(result.success).toBe(true);
    });

    it('accepts array content', () => {
      const result = ToolResultBlockSchema.safeParse({
        type: 'tool_result',
        tool_use_id: 'tu_123',
        content: [{ type: 'text', text: 'output here' }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts is_error flag', () => {
      const result = ToolResultBlockSchema.safeParse({
        type: 'tool_result',
        tool_use_id: 'tu_123',
        content: 'error output',
        is_error: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.is_error).toBe(true);
      }
    });
  });

  describe('ContentBlockSchema (discriminated union)', () => {
    it('discriminates text blocks', () => {
      const result = ContentBlockSchema.safeParse({ type: 'text', text: 'hello' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.type).toBe('text');
    });

    it('discriminates tool_use blocks', () => {
      const result = ContentBlockSchema.safeParse({
        type: 'tool_use',
        id: 'x',
        name: 'Read',
        input: {},
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.type).toBe('tool_use');
    });

    it('rejects unknown type discriminator', () => {
      const result = ContentBlockSchema.safeParse({ type: 'image', url: 'http://...' });
      expect(result.success).toBe(false);
    });
  });
});

// ── Claude schemas ───────────────────────────────────────────────────────────

describe('ClaudeMessageSchema', () => {
  const validMsg = {
    type: 'human',
    uuid: 'abc-123',
    timestamp: '2025-01-01T00:00:00Z',
    sessionId: 'sess_1',
    cwd: '/home/user/project',
    message: {
      role: 'user',
      content: 'Hello',
    },
  };

  it('accepts valid Claude message', () => {
    const result = ClaudeMessageSchema.safeParse(validMsg);
    expect(result.success).toBe(true);
  });

  it('accepts message with content block array', () => {
    const msg = {
      ...validMsg,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'response' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    const result = ClaudeMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('accepts optional fields (model, isCompactSummary, gitBranch)', () => {
    const msg = {
      ...validMsg,
      model: 'claude-sonnet-4-20250514',
      isCompactSummary: true,
      gitBranch: 'main',
    };
    const result = ClaudeMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('tolerates extra fields via passthrough', () => {
    const msg = { ...validMsg, unknownField: 'extra data' };
    const result = ClaudeMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects missing uuid', () => {
    const { uuid, ...noUuid } = validMsg;
    const result = ClaudeMessageSchema.safeParse(noUuid);
    expect(result.success).toBe(false);
  });
});

// ── Codex schemas ────────────────────────────────────────────────────────────

describe('CodexMessageSchema (discriminated union)', () => {
  it('accepts session_meta', () => {
    const result = CodexSessionMetaSchema.safeParse({
      timestamp: '2025-01-01T00:00:00Z',
      type: 'session_meta',
      payload: { id: 'sess_1', cwd: '/tmp' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts event_msg', () => {
    const result = CodexEventMsgSchema.safeParse({
      timestamp: '2025-01-01T00:00:00Z',
      type: 'event_msg',
      payload: { role: 'user', message: 'hello' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts response_item', () => {
    const result = CodexResponseItemSchema.safeParse({
      timestamp: '2025-01-01T00:00:00Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts turn_context', () => {
    const result = CodexTurnContextSchema.safeParse({
      timestamp: '2025-01-01T00:00:00Z',
      type: 'turn_context',
      payload: { model: 'o3-mini' },
    });
    expect(result.success).toBe(true);
  });

  it('discriminates correctly in union', () => {
    const meta = {
      timestamp: '2025-01-01T00:00:00Z',
      type: 'session_meta',
      payload: { id: 'x' },
    };
    const result = CodexMessageSchema.safeParse(meta);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe('session_meta');
  });

  it('rejects unknown type in union', () => {
    const result = CodexMessageSchema.safeParse({
      timestamp: '2025-01-01T00:00:00Z',
      type: 'unknown_type',
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});

// ── Copilot schemas ──────────────────────────────────────────────────────────

describe('CopilotWorkspaceSchema', () => {
  it('accepts valid workspace', () => {
    const result = CopilotWorkspaceSchema.safeParse({
      id: 'ws_1',
      cwd: '/home/user/proj',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-02T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional fields', () => {
    const result = CopilotWorkspaceSchema.safeParse({
      id: 'ws_1',
      cwd: '/tmp',
      git_root: '/tmp',
      repository: 'owner/repo',
      branch: 'main',
      summary: 'test session',
      summary_count: 5,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-02T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('CopilotEventSchema', () => {
  it('accepts valid event', () => {
    const result = CopilotEventSchema.safeParse({
      type: 'user.message',
      id: 'evt_1',
      timestamp: '2025-01-01T00:00:00Z',
      data: { content: 'hello' },
    });
    expect(result.success).toBe(true);
  });
});

// ── Gemini schemas ───────────────────────────────────────────────────────────

describe('GeminiMessageSchema', () => {
  it('accepts message with string content', () => {
    const result = GeminiMessageSchema.safeParse({
      id: 'msg_1',
      timestamp: '2025-01-01T00:00:00Z',
      type: 'user',
      content: 'hello',
    });
    expect(result.success).toBe(true);
  });

  it('accepts message with array content', () => {
    const result = GeminiMessageSchema.safeParse({
      id: 'msg_1',
      timestamp: '2025-01-01T00:00:00Z',
      type: 'model',
      content: [{ text: 'response', type: 'text' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts tool calls', () => {
    const result = GeminiMessageSchema.safeParse({
      id: 'msg_1',
      timestamp: '2025-01-01T00:00:00Z',
      type: 'model',
      content: 'using tool',
      toolCalls: [{ name: 'shell', args: { command: 'ls' } }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts token usage', () => {
    const result = GeminiMessageSchema.safeParse({
      id: 'msg_1',
      timestamp: '2025-01-01T00:00:00Z',
      type: 'model',
      content: 'response',
      tokens: { input: 100, output: 50, total: 150 },
    });
    expect(result.success).toBe(true);
  });
});

describe('GeminiSessionSchema', () => {
  it('accepts valid session', () => {
    const result = GeminiSessionSchema.safeParse({
      sessionId: 'sess_1',
      projectHash: 'abc123',
      startTime: '2025-01-01T00:00:00Z',
      lastUpdated: '2025-01-02T00:00:00Z',
      messages: [{ id: 'msg_1', timestamp: '2025-01-01T00:00:00Z', type: 'user', content: 'hi' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('GeminiToolCallSchema', () => {
  it('accepts tool call with resultDisplay', () => {
    const result = GeminiToolCallSchema.safeParse({
      name: 'edit_file',
      args: { path: '/tmp/test.ts' },
      resultDisplay: {
        fileName: 'test.ts',
        filePath: '/tmp/test.ts',
        diffStat: { model_added_lines: 5, model_removed_lines: 2 },
        isNewFile: false,
      },
    });
    expect(result.success).toBe(true);
  });
});

// ── OpenCode schemas ─────────────────────────────────────────────────────────

describe('OpenCodeSessionSchema', () => {
  it('accepts valid session', () => {
    const result = OpenCodeSessionSchema.safeParse({
      id: 'sess_1',
      projectID: 'proj_1',
      directory: '/home/user/proj',
      time: { created: 1704067200, updated: 1704153600 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional summary fields', () => {
    const result = OpenCodeSessionSchema.safeParse({
      id: 'sess_1',
      projectID: 'proj_1',
      directory: '/tmp',
      time: { created: 1704067200, updated: 1704153600 },
      slug: 'test-session',
      title: 'Test Session',
      summary: { additions: 10, deletions: 5, files: 3 },
    });
    expect(result.success).toBe(true);
  });
});

describe('OpenCodeMessageSchema', () => {
  it('accepts valid message', () => {
    const result = OpenCodeMessageSchema.safeParse({
      id: 'msg_1',
      sessionID: 'sess_1',
      role: 'user',
      time: { created: 1704067200 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid role', () => {
    const result = OpenCodeMessageSchema.safeParse({
      id: 'msg_1',
      sessionID: 'sess_1',
      role: 'system',
      time: { created: 1704067200 },
    });
    expect(result.success).toBe(false);
  });
});

describe('SqliteSessionRowSchema', () => {
  it('accepts valid SQLite row', () => {
    const result = SqliteSessionRowSchema.safeParse({
      id: 'sess_1',
      project_id: 'proj_1',
      slug: 'test',
      directory: '/tmp',
      title: 'Test',
      version: '1.0',
      summary_additions: 10,
      summary_deletions: null,
      summary_files: 3,
      time_created: 1704067200,
      time_updated: 1704153600,
    });
    expect(result.success).toBe(true);
  });
});

// ── Droid schemas ────────────────────────────────────────────────────────────

describe('DroidEventSchema (discriminated union)', () => {
  it('accepts session_start', () => {
    const result = DroidSessionStartSchema.safeParse({
      type: 'session_start',
      id: 'sess_1',
      title: 'My Session',
      sessionTitle: 'My Session',
      cwd: '/home/user/proj',
    });
    expect(result.success).toBe(true);
  });

  it('accepts message event', () => {
    const result = DroidMessageEventSchema.safeParse({
      type: 'message',
      id: 'msg_1',
      timestamp: '2025-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts todo_state', () => {
    const result = DroidTodoStateSchema.safeParse({
      type: 'todo_state',
      id: 'todo_1',
      timestamp: '2025-01-01T00:00:00Z',
      todos: '- [ ] task 1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts compaction_state', () => {
    const result = DroidCompactionStateSchema.safeParse({
      type: 'compaction_state',
      id: 'comp_1',
      timestamp: '2025-01-01T00:00:00Z',
      summaryText: 'Compacted conversation summary',
      summaryTokens: 500,
    });
    expect(result.success).toBe(true);
  });

  it('discriminates correctly in union', () => {
    const msg = {
      type: 'message',
      id: 'msg_1',
      timestamp: '2025-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will help.' }],
      },
    };
    const result = DroidEventSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe('message');
  });

  it('rejects unknown type in union', () => {
    const result = DroidEventSchema.safeParse({
      type: 'unknown',
      id: 'x',
      timestamp: '2025-01-01T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('DroidSettingsSchema', () => {
  it('accepts settings with token usage', () => {
    const result = DroidSettingsSchema.safeParse({
      model: 'claude-sonnet-4-20250514',
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 200,
      },
    });
    expect(result.success).toBe(true);
  });
});

// ── Cursor schemas ───────────────────────────────────────────────────────────

describe('CursorTranscriptLineSchema', () => {
  it('accepts user message', () => {
    const result = CursorTranscriptLineSchema.safeParse({
      role: 'user',
      message: {
        content: [{ type: 'text', text: 'fix the bug' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts assistant message with tool use', () => {
    const result = CursorTranscriptLineSchema.safeParse({
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me look at the code.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/test.ts' } },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects system role', () => {
    const result = CursorTranscriptLineSchema.safeParse({
      role: 'system',
      message: { content: [{ type: 'text', text: 'prompt' }] },
    });
    expect(result.success).toBe(false);
  });
});

// ── Serialized Session (Index) ───────────────────────────────────────────────

describe('SerializedSessionSchema', () => {
  const validSession = {
    id: 'sess_1',
    source: 'claude',
    cwd: '/home/user/project',
    lines: 42,
    bytes: 12345,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    originalPath: '/home/user/.claude/projects/proj/session.jsonl',
  };

  it('accepts valid session and transforms dates', () => {
    const result = SerializedSessionSchema.safeParse(validSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.createdAt).toBeInstanceOf(Date);
      expect(result.data.updatedAt).toBeInstanceOf(Date);
      expect(result.data.createdAt.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    }
  });

  it('validates source against TOOL_NAMES', () => {
    const result = SerializedSessionSchema.safeParse({
      ...validSession,
      source: 'unknown_tool',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid source values', () => {
    for (const source of TOOL_NAMES) {
      const result = SerializedSessionSchema.safeParse({ ...validSession, source });
      expect(result.success).toBe(true);
    }
  });

  it('accepts optional fields', () => {
    const result = SerializedSessionSchema.safeParse({
      ...validSession,
      repo: 'owner/repo',
      branch: 'main',
      summary: 'Test session',
      model: 'claude-sonnet-4-20250514',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const { id, ...noId } = validSession;
    expect(SerializedSessionSchema.safeParse(noId).success).toBe(false);

    const { cwd, ...noCwd } = validSession;
    expect(SerializedSessionSchema.safeParse(noCwd).success).toBe(false);

    const { lines, ...noLines } = validSession;
    expect(SerializedSessionSchema.safeParse(noLines).success).toBe(false);
  });
});

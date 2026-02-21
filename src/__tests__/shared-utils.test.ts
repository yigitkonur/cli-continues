/**
 * Tests for shared utility modules created in Wave 2.
 * Covers: jsonl, fs-helpers, content, tool-extraction, parser-helpers additions.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationMessage } from '../types/index.js';
import {
  cleanUserQueryText,
  extractRepoFromGitUrl,
  extractTextFromBlocks,
  isRealUserMessage,
  isSystemContent,
} from '../utils/content.js';
import { findFiles, listSubdirectories } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { extractRepo, trimMessages } from '../utils/parser-helpers.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';

// ── Temp file helpers ────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ── jsonl.ts ─────────────────────────────────────────────────────────────────

describe('readJsonlFile', () => {
  it('reads valid JSONL file', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3}\n');

    const result = await readJsonlFile<{ a: number }>(file);
    expect(result).toHaveLength(3);
    expect(result[0].a).toBe(1);
    expect(result[2].a).toBe(3);
  });

  it('skips invalid lines', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    fs.writeFileSync(file, '{"ok":true}\nnot json\n{"ok":false}\n');

    const result = await readJsonlFile<{ ok: boolean }>(file);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for non-existent file', async () => {
    const result = await readJsonlFile('/tmp/nonexistent-file.jsonl');
    expect(result).toEqual([]);
  });
});

describe('scanJsonlHead', () => {
  it('scans first N lines and stops', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i }));
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const visited: number[] = [];
    await scanJsonlHead(file, 5, (parsed) => {
      visited.push((parsed as { i: number }).i);
      return 'continue';
    });

    expect(visited).toHaveLength(5);
    expect(visited).toEqual([0, 1, 2, 3, 4]);
  });

  it('supports early stop via visitor', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    fs.writeFileSync(file, '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');

    const visited: string[] = [];
    await scanJsonlHead(file, 100, (parsed) => {
      const p = parsed as { type: string };
      visited.push(p.type);
      return p.type === 'b' ? 'stop' : 'continue';
    });

    expect(visited).toEqual(['a', 'b']);
  });

  it('handles non-existent file gracefully', async () => {
    await scanJsonlHead('/tmp/nonexistent.jsonl', 10, () => 'continue');
    // No error thrown
  });
});

describe('getFileStats', () => {
  it('returns line count and byte size', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'test.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3}\n');

    const stats = await getFileStats(file);
    expect(stats.lines).toBe(3);
    expect(stats.bytes).toBeGreaterThan(0);
  });
});

// ── fs-helpers.ts ────────────────────────────────────────────────────────────

describe('findFiles', () => {
  it('finds files matching predicate', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'b.txt'), '');
    fs.writeFileSync(path.join(dir, 'c.jsonl'), '');

    const files = findFiles(dir, {
      match: (entry) => entry.name.endsWith('.jsonl'),
    });
    expect(files).toHaveLength(2);
  });

  it('recurses into subdirectories by default', () => {
    const dir = makeTmpDir();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '');
    fs.writeFileSync(path.join(sub, 'b.jsonl'), '');

    const files = findFiles(dir, {
      match: (entry) => entry.name.endsWith('.jsonl'),
    });
    expect(files).toHaveLength(2);
  });

  it('respects maxDepth', () => {
    const dir = makeTmpDir();
    const sub = path.join(dir, 'sub');
    const subsub = path.join(sub, 'subsub');
    fs.mkdirSync(sub);
    fs.mkdirSync(subsub);
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '');
    fs.writeFileSync(path.join(sub, 'b.jsonl'), '');
    fs.writeFileSync(path.join(subsub, 'c.jsonl'), '');

    const files = findFiles(dir, {
      match: (entry) => entry.name.endsWith('.jsonl'),
      maxDepth: 1,
    });
    expect(files).toHaveLength(2); // a.jsonl + sub/b.jsonl
  });

  it('returns empty for non-existent directory', () => {
    const files = findFiles('/tmp/nonexistent-dir', {
      match: () => true,
    });
    expect(files).toEqual([]);
  });
});

describe('listSubdirectories', () => {
  it('lists immediate subdirectories', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'file.txt'), '');

    const dirs = listSubdirectories(dir);
    expect(dirs).toHaveLength(2);
  });

  it('returns empty for non-existent directory', () => {
    expect(listSubdirectories('/tmp/nonexistent-dir')).toEqual([]);
  });
});

// ── content.ts ───────────────────────────────────────────────────────────────

describe('extractTextFromBlocks', () => {
  it('returns string content as-is', () => {
    expect(extractTextFromBlocks('hello')).toBe('hello');
  });

  it('extracts text blocks from array', () => {
    const content = [
      { type: 'text', text: 'line 1' },
      { type: 'tool_use', text: 'not this' },
      { type: 'text', text: 'line 2' },
    ];
    expect(extractTextFromBlocks(content)).toBe('line 1\nline 2');
  });

  it('returns empty for undefined', () => {
    expect(extractTextFromBlocks(undefined)).toBe('');
  });
});

describe('isSystemContent', () => {
  it('detects system-reminder tags', () => {
    expect(isSystemContent('<system-reminder>...')).toBe(true);
  });

  it('detects permissions tags', () => {
    expect(isSystemContent('<permissions>...')).toBe(true);
  });

  it('does not flag regular text', () => {
    expect(isSystemContent('Hello, please fix the bug')).toBe(false);
  });
});

describe('isRealUserMessage', () => {
  it('accepts normal user text', () => {
    expect(isRealUserMessage('fix the login bug')).toBe(true);
  });

  it('rejects XML-prefixed content', () => {
    expect(isRealUserMessage('<environment_context>...')).toBe(false);
  });

  it('rejects commands', () => {
    expect(isRealUserMessage('/help')).toBe(false);
  });

  it('rejects handoff summaries', () => {
    expect(isRealUserMessage('Session Handoff from Claude')).toBe(false);
  });

  it('rejects empty text', () => {
    expect(isRealUserMessage('')).toBe(false);
  });
});

describe('extractRepoFromGitUrl', () => {
  it('extracts from HTTPS URL', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('extracts from SSH URL', () => {
    expect(extractRepoFromGitUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('extracts without .git suffix', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('returns empty for invalid URL', () => {
    expect(extractRepoFromGitUrl('not-a-url')).toBe('');
  });

  it('returns empty for empty string', () => {
    expect(extractRepoFromGitUrl('')).toBe('');
  });
});

describe('cleanUserQueryText', () => {
  it('extracts text from user_query tags', () => {
    expect(cleanUserQueryText('<user_query>fix the bug</user_query>')).toBe('fix the bug');
  });

  it('returns original text if no tags', () => {
    expect(cleanUserQueryText('just text')).toBe('just text');
  });
});

// ── tool-extraction.ts ───────────────────────────────────────────────────────

describe('extractAnthropicToolData', () => {
  it('extracts shell tool usage', () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'exit code 0' }],
      },
    ];

    const { summaries } = extractAnthropicToolData(messages);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('Bash');
    expect(summaries[0].count).toBe(1);
  });

  it('extracts file modifications', () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/tmp/test.ts' } },
          { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/tmp/other.ts' } },
        ],
      },
    ];

    const { filesModified } = extractAnthropicToolData(messages);
    expect(filesModified).toContain('/tmp/test.ts');
    expect(filesModified).toContain('/tmp/other.ts');
  });

  it('skips SKIP_TOOLS', () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'TodoWrite', input: {} },
          { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/test.ts' } },
        ],
      },
    ];

    const { summaries } = extractAnthropicToolData(messages);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('Read');
  });

  it('handles MCP tools', () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__github-server___list-issues', input: { repo: 'test' } }],
      },
    ];

    const { summaries } = extractAnthropicToolData(messages);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('mcp__github-server___list-issues');
  });

  it('handles empty messages', () => {
    const { summaries, filesModified } = extractAnthropicToolData([]);
    expect(summaries).toEqual([]);
    expect(filesModified).toEqual([]);
  });
});

describe('extractThinkingHighlights', () => {
  it('extracts reasoning from thinking blocks', () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'I need to understand the authentication flow before making changes' }],
      },
    ];

    const highlights = extractThinkingHighlights(messages);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]).toContain('I need to understand the authentication flow');
  });

  it('respects maxHighlights limit', () => {
    const messages: AnthropicMessage[] = Array.from({ length: 10 }, () => ({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Some reasoning that is long enough to be captured here' }],
    }));

    const highlights = extractThinkingHighlights(messages, 3);
    expect(highlights).toHaveLength(3);
  });

  it('skips very short thinking blocks', () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'ok' }, // too short
          { type: 'thinking', thinking: 'This is a substantial reasoning block that should be captured' },
        ],
      },
    ];

    const highlights = extractThinkingHighlights(messages);
    expect(highlights).toHaveLength(1);
  });

  it('uses text field as fallback when thinking is absent', () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', text: 'Reasoning via text field which is quite long enough' }],
      },
    ];

    const highlights = extractThinkingHighlights(messages);
    expect(highlights).toHaveLength(1);
  });
});

// ── parser-helpers.ts additions ──────────────────────────────────────────────

describe('extractRepo', () => {
  it('prefers git URL when available', () => {
    expect(
      extractRepo({
        gitUrl: 'https://github.com/owner/repo.git',
        cwd: '/home/user/project',
      }),
    ).toBe('owner/repo');
  });

  it('falls back to cwd when no git URL', () => {
    expect(extractRepo({ cwd: '/home/user/project' })).toBe('user/project');
  });

  it('falls back to cwd when git URL is invalid', () => {
    expect(
      extractRepo({
        gitUrl: 'not-a-url',
        cwd: '/home/user/project',
      }),
    ).toBe('user/project');
  });

  it('returns empty for no inputs', () => {
    expect(extractRepo({})).toBe('');
  });
});

describe('trimMessages', () => {
  const msg = (role: 'user' | 'assistant', i: number): ConversationMessage => ({
    role,
    content: `msg ${i}`,
  });

  it('returns last N messages', () => {
    const msgs = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)];
    expect(trimMessages(msgs, 2)).toHaveLength(2);
    expect(trimMessages(msgs, 2)[0].content).toBe('msg 3');
  });

  it('includes last user message when tail has none', () => {
    const msgs = [msg('user', 1), msg('assistant', 2), msg('assistant', 3), msg('assistant', 4), msg('assistant', 5)];
    const trimmed = trimMessages(msgs, 3);
    expect(trimmed.some((m) => m.role === 'user')).toBe(true);
  });

  it('returns all messages when count <= maxCount', () => {
    const msgs = [msg('user', 1), msg('assistant', 2)];
    expect(trimMessages(msgs, 10)).toHaveLength(2);
  });
});

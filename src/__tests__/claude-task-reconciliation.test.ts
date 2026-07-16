import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getPreset } from '../config/index.js';
import { extractClaudeContext } from '../parsers/claude.js';
import type { UnifiedSession } from '../types/index.js';

function makeSession(originalPath: string): UnifiedSession {
  const now = new Date('2026-03-03T00:00:00.000Z');
  return {
    id: 'test-session',
    source: 'claude',
    cwd: '/tmp',
    lines: 0,
    bytes: 0,
    createdAt: now,
    updatedAt: now,
    originalPath,
  };
}

function writeJsonl(filePath: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

describe('Claude task reconciliation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not mark local_bash queue tasks as pending subagents', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-claude-bash-'));
    tempDirs.push(tmp);
    const filePath = path.join(tmp, 'session.jsonl');

    writeJsonl(filePath, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: '{"task_id":"b57b3c5","description":"Watch CI run until completion","task_type":"local_bash"}',
      },
      {
        type: 'assistant',
        timestamp: '2026-03-03T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      },
    ]);

    const ctx = await extractClaudeContext(makeSession(filePath), getPreset('standard'));
    expect(ctx.pendingTasks).not.toContain('Incomplete subagent: Watch CI run until completion');
  });

  it('keeps local_agent without terminal evidence as pending when transcript is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-claude-agent-'));
    tempDirs.push(tmp);
    const filePath = path.join(tmp, 'session.jsonl');

    writeJsonl(filePath, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: '{"task_id":"a111111","description":"Explore formatting","task_type":"local_agent"}',
      },
    ]);

    const ctx = await extractClaudeContext(makeSession(filePath), getPreset('standard'));
    expect(ctx.pendingTasks).toContain('Incomplete subagent: Explore formatting');
  });

  it('uses TaskOutput completion status as terminal evidence', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-claude-taskoutput-'));
    tempDirs.push(tmp);
    const filePath = path.join(tmp, 'session.jsonl');

    writeJsonl(filePath, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: '{"task_id":"a222222","description":"Create docs","task_type":"local_agent"}',
      },
      {
        type: 'assistant',
        timestamp: '2026-03-03T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-taskoutput', name: 'TaskOutput', input: { task_id: 'a222222' } }],
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-03T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-taskoutput',
              content:
                '<retrieval_status>success</retrieval_status><task_id>a222222</task_id><status>completed</status>',
            },
          ],
        },
      },
    ]);

    const ctx = await extractClaudeContext(makeSession(filePath), getPreset('standard'));
    expect(ctx.pendingTasks).not.toContain('Incomplete subagent: Create docs');
  });

  it('uses XML task-notification status as terminal evidence', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-claude-tasknotif-'));
    tempDirs.push(tmp);
    const filePath = path.join(tmp, 'session.jsonl');

    writeJsonl(filePath, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: '{"task_id":"a333333","description":"Create architecture docs","task_type":"local_agent"}',
      },
      {
        type: 'user',
        timestamp: '2026-03-03T00:00:03.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<task-notification><task-id>a333333</task-id><status>completed</status><summary>done</summary></task-notification>',
            },
          ],
        },
      },
    ]);

    const ctx = await extractClaudeContext(makeSession(filePath), getPreset('standard'));
    expect(ctx.pendingTasks).not.toContain('Incomplete subagent: Create architecture docs');
  });

  it('keeps the last real user message when assistant tool-only rows dominate the tail', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-claude-tail-'));
    tempDirs.push(tmp);
    const filePath = path.join(tmp, 'session.jsonl');

    writeJsonl(filePath, [
      {
        type: 'user',
        timestamp: '2026-03-03T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Please fix the hidden parser bug' }] },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: 'assistant',
        timestamp: `2026-03-03T00:00:${String(index + 2).padStart(2, '0')}.000Z`,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `toolu-${index}`, name: 'Read', input: { file_path: `file-${index}.ts` } }],
        },
      })),
    ]);

    const cfg = { ...getPreset('standard'), recentMessages: 3 };
    const ctx = await extractClaudeContext(makeSession(filePath), cfg);
    expect(ctx.recentMessages.map((message) => message.content)).toContain('Please fix the hidden parser bug');
    expect(ctx.markdown).toContain('Please fix the hidden parser bug');
  });

  it('extracts current Agent tool results via toolUseResult.agentId sidecars', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-claude-agent-tool-'));
    tempDirs.push(tmp);
    const filePath = path.join(tmp, 'session.jsonl');
    const sessionDir = filePath.replace(/\.jsonl$/, '');
    const sidecarPath = path.join(sessionDir, 'subagents', 'agent-abc123.jsonl');

    writeJsonl(filePath, [
      {
        type: 'assistant',
        timestamp: '2026-03-03T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-agent',
              name: 'Agent',
              input: { description: 'Investigate parser ordering', subagent_type: 'Explore' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-03T00:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu-agent', content: [{ type: 'text', text: 'done' }] }],
        },
        toolUseResult: { status: 'completed', agentId: 'abc123' },
      },
    ]);

    writeJsonl(sidecarPath, [
      {
        type: 'assistant',
        timestamp: '2026-03-03T00:00:03.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'The parser should use transcript timestamps and preserve the final user request in handoff context.',
            },
          ],
        },
      },
    ]);

    const ctx = await extractClaudeContext(makeSession(filePath), getPreset('standard'));

    expect(ctx.sessionNotes?.subagentResults?.[0]).toMatchObject({
      taskId: 'abc123',
      description: 'Investigate parser ordering',
      status: 'completed',
    });
    expect(ctx.sessionNotes?.subagentResults?.[0].result).toContain('transcript timestamps');
  });

  it('does not mark completed Agent sidecars without substantial text as incomplete', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-claude-agent-completed-'));
    tempDirs.push(tmp);
    const filePath = path.join(tmp, 'session.jsonl');
    const sessionDir = filePath.replace(/\.jsonl$/, '');
    const sidecarPath = path.join(sessionDir, 'subagents', 'agent-completed123.jsonl');

    writeJsonl(filePath, [
      {
        type: 'assistant',
        timestamp: '2026-03-03T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-agent-completed',
              name: 'Agent',
              input: { description: 'Check completed sidecar' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-03-03T00:00:02.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-agent-completed', content: [{ type: 'text', text: '' }] },
          ],
        },
        toolUseResult: { agentId: 'completed123' },
      },
    ]);

    writeJsonl(sidecarPath, [
      {
        type: 'assistant',
        timestamp: '2026-03-03T00:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ]);

    const ctx = await extractClaudeContext(makeSession(filePath), getPreset('standard'));

    expect(ctx.sessionNotes?.subagentResults?.[0]).toMatchObject({
      taskId: 'completed123',
      description: 'Check completed sidecar',
      status: 'completed',
    });
    expect(ctx.pendingTasks).not.toContain('Incomplete subagent: Check completed sidecar');
  });
});

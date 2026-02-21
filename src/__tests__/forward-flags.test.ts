import { describe, expect, it } from 'vitest';
import { adapters } from '../parsers/registry.js';
import type { UnifiedSession } from '../types/index.js';
import { getResumeCommand, resolveCrossToolForwarding } from '../utils/resume.js';

describe('cross-tool forwarding', () => {
  it('enforces codex precedence yolo > full-auto > sandbox', () => {
    const resolved = resolveCrossToolForwarding('codex', {
      rawArgs: ['--yolo', '--full-auto', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    });

    expect(resolved.mappedArgs).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(resolved.passthroughArgs).toEqual([]);
    expect(resolved.warnings.length).toBeGreaterThan(0);
  });

  it('passes unmapped flags through unchanged', () => {
    const resolved = resolveCrossToolForwarding('claude', {
      rawArgs: ['--search', '--unknown-flag', 'value'],
    });

    expect(resolved.mappedArgs).toEqual([]);
    expect(resolved.passthroughArgs).toEqual(['--search', '--unknown-flag', 'value']);
    expect(resolved.extraArgs).toEqual(['--search', '--unknown-flag', 'value']);
  });

  it('keeps unsupported known flags as passthrough when target has no mapping', () => {
    const resolved = resolveCrossToolForwarding('claude', {
      rawArgs: ['--full-auto'],
    });

    expect(resolved.mappedArgs).toEqual([]);
    expect(resolved.passthroughArgs).toEqual(['--full-auto']);
  });

  it('maps add-dir category into gemini include-directories', () => {
    const resolved = resolveCrossToolForwarding('gemini', {
      rawArgs: ['--add-dir', '/tmp/workspace'],
    });

    expect(resolved.mappedArgs).toEqual(['--include-directories', '/tmp/workspace']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('maps cursor target using agent semantics', () => {
    expect(adapters.cursor.binaryName).toBe('agent');

    const resolved = resolveCrossToolForwarding('cursor', {
      rawArgs: ['--sandbox', 'workspace-write', '--model', 'gpt-5', '--approve-mcps'],
    });

    expect(resolved.mappedArgs).toEqual(['--model', 'gpt-5', '--sandbox', 'enabled', '--approve-mcps']);
    expect(resolved.passthroughArgs).toEqual([]);
  });

  it('shows mapped forward args in cross-tool command preview', () => {
    const session: UnifiedSession = {
      id: 'abc123456789',
      source: 'claude',
      cwd: '/tmp/project',
      lines: 10,
      bytes: 120,
      createdAt: new Date('2026-02-20T00:00:00.000Z'),
      updatedAt: new Date('2026-02-20T00:00:00.000Z'),
      originalPath: '/tmp/session.jsonl',
    };

    const command = getResumeCommand(session, 'codex', {
      rawArgs: ['--yolo', '--search'],
    });

    expect(command).toContain('continues resume abc123456789 --in codex');
    expect(command).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(command).toContain('--search');
  });
});

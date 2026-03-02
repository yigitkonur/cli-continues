import { describe, expect, it } from 'vitest';
import type { UnifiedSession } from '../types/index.js';
import { TOOL_NAMES } from '../types/tool-names.js';
import { buildWindowsSafePrompt } from '../utils/resume.js';

// Minimal session stub for testing
function stubSession(source: UnifiedSession['source']): UnifiedSession {
  return {
    id: 'test-id',
    source,
    summary: 'Test session',
    cwd: '/test/dir',
    updatedAt: new Date(),
    createdAt: new Date(),
    originalPath: '/test/path',
    lines: 0,
    bytes: 0,
  };
}

// Characters that are dangerous in cmd.exe
const CMD_METACHARACTERS = /[|&><^%!`"\n\r]/;

describe('buildWindowsSafePrompt', () => {
  it('should return a single-line string', () => {
    const prompt = buildWindowsSafePrompt(stubSession('claude'));
    expect(prompt).not.toContain('\n');
    expect(prompt).not.toContain('\r');
  });

  it('should not contain cmd.exe metacharacters', () => {
    const prompt = buildWindowsSafePrompt(stubSession('claude'));
    expect(CMD_METACHARACTERS.test(prompt)).toBe(false);
  });

  it('should be under 300 characters', () => {
    const prompt = buildWindowsSafePrompt(stubSession('claude'));
    expect(prompt.length).toBeLessThan(300);
  });

  it('should reference .continues-handoff.md', () => {
    const prompt = buildWindowsSafePrompt(stubSession('claude'));
    expect(prompt).toContain('.continues-handoff.md');
  });

  it('should include the source tool name', () => {
    const prompt = buildWindowsSafePrompt(stubSession('codex'));
    expect(prompt).toContain('codex');
  });

  it('should be safe for all supported tools', () => {
    const tools = TOOL_NAMES;
    for (const tool of tools) {
      const prompt = buildWindowsSafePrompt(stubSession(tool));
      expect(CMD_METACHARACTERS.test(prompt)).toBe(false);
      expect(prompt).not.toContain('\n');
      expect(prompt.length).toBeLessThan(300);
    }
  });
});

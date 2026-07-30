import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { cwdFromSlug } from '../utils/slug.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

describe('cwdFromSlug', () => {
  const itWindows = process.platform === 'win32' ? it : it.skip;

  itWindows('resolves Windows drive-letter slugs using existing path', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'continues-slug-'));
    const target = path.join(base, 'project-alpha');
    fs.mkdirSync(target, { recursive: true });

    const normalized = target.replace(/\\/g, '/');
    const slug = normalized.replace(':', '').replace(/[/.]/g, '-');
    const resolved = cwdFromSlug(slug).replace(/\\/g, '/');

    expect(resolved.toLowerCase()).toBe(normalized.toLowerCase());

    fs.rmSync(base, { recursive: true, force: true });
  });

  itWindows('falls back to drive-letter path format when no candidate exists', () => {
    expect(cwdFromSlug('D-Workspace-project-alpha')).toBe('D:/Workspace/project/alpha');
  });

  it('falls back to Unix path format for drive-letter-like slugs on non-Windows', () => {
    if (process.platform === 'win32') return;
    expect(cwdFromSlug('D-Workspace-project-alpha')).toBe('/D/Workspace/project/alpha');
  });

  it('keeps Unix fallback behavior for non-drive slugs', () => {
    expect(cwdFromSlug('Users-alice-my-project')).toBe('/Users/alice/my/project');
  });

  it('caps filesystem probes for unresolved dash-heavy slugs', () => {
    const existsSync = vi.mocked(fs.existsSync);
    const originalImplementation = existsSync.getMockImplementation();
    existsSync.mockClear();
    existsSync.mockReturnValue(false);

    try {
      const resolved = cwdFromSlug('private-tmp-claude-501-Users-alice-project-session-scratchpad-hooktest-extra-one');

      expect(resolved).toBe('/private/tmp/claude/501/Users/alice/project/session/scratchpad/hooktest/extra/one');
      expect(existsSync.mock.calls.length).toBeLessThanOrEqual(10_000);
    } finally {
      existsSync.mockImplementation(originalImplementation!);
    }
  });
});

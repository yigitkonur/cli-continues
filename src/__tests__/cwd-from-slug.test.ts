import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { cwdFromSlug } from '../utils/slug.js';

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

  it('uses the bounded fallback for long Cursor slugs quickly', () => {
    const slug = 'continues-regression-a-b-c-d-e-f-g-h-i-j-k';
    const startedAt = performance.now();
    const resolved = cwdFromSlug(slug);
    const elapsedMs = performance.now() - startedAt;

    expect(resolved).toBe(`/${slug.replace(/-/g, '/')}`);
    expect(elapsedMs).toBeLessThan(100);
  });
});

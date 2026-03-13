import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

  it('falls back to drive-letter path format when no candidate exists', () => {
    expect(cwdFromSlug('D-Workspace-project-alpha')).toBe('D:/Workspace/project/alpha');
  });

  it('keeps Unix fallback behavior for non-drive slugs', () => {
    expect(cwdFromSlug('Users-alice-my-project')).toBe('/Users/alice/my/project');
  });
});

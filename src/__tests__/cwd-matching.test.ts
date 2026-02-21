import { describe, expect, it } from 'vitest';
import { matchesCwd } from '../utils/slug.js';

describe('matchesCwd', () => {
  it('exact match', () => {
    expect(matchesCwd('/Users/me/project', '/Users/me/project')).toBe(true);
  });

  it('subdirectory match', () => {
    expect(matchesCwd('/Users/me/project/src', '/Users/me/project')).toBe(true);
  });

  it('deeply nested subdirectory match', () => {
    expect(matchesCwd('/Users/me/project/src/utils/deep', '/Users/me/project')).toBe(true);
  });

  it('non-match: different directory', () => {
    expect(matchesCwd('/Users/me/other', '/Users/me/project')).toBe(false);
  });

  it('non-match: partial name overlap', () => {
    expect(matchesCwd('/Users/me/project-v2', '/Users/me/project')).toBe(false);
  });

  it('non-match: parent directory', () => {
    expect(matchesCwd('/Users/me', '/Users/me/project')).toBe(false);
  });

  it('handles trailing slashes on session cwd', () => {
    expect(matchesCwd('/Users/me/project/', '/Users/me/project')).toBe(true);
  });

  it('handles trailing slashes on target dir', () => {
    expect(matchesCwd('/Users/me/project', '/Users/me/project/')).toBe(true);
  });

  it('handles trailing slashes on both', () => {
    expect(matchesCwd('/Users/me/project/', '/Users/me/project/')).toBe(true);
  });

  it('empty session cwd returns false', () => {
    expect(matchesCwd('', '/Users/me/project')).toBe(false);
  });

  it('empty target dir returns false', () => {
    expect(matchesCwd('/Users/me/project', '')).toBe(false);
  });

  it('root target returns false', () => {
    expect(matchesCwd('/Users/me/project', '/')).toBe(false);
  });
});

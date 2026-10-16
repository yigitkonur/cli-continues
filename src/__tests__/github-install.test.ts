import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>;
  files: string[];
  version: string;
};

describe('GitHub installation', () => {
  it('ships a runnable CLI without an install-time build', () => {
    const entry = manifest.bin.continues;
    expect(manifest.bin.cont).toBe(entry);
    expect(manifest.files).toEqual(expect.arrayContaining(['bin', 'src']));
    const install = mkdtempSync(join(tmpdir(), 'continues-github-'));
    try {
      mkdirSync(join(install, 'bin'));
      copyFileSync(join(root, entry), join(install, entry));
      copyFileSync(join(root, 'package.json'), join(install, 'package.json'));
      cpSync(join(root, 'src'), join(install, 'src'), { recursive: true });
      symlinkSync(join(root, 'node_modules'), join(install, 'node_modules'), 'dir');
      expect(execFileSync(process.execPath, [entry, '--version'], { cwd: install, encoding: 'utf8' }).trim()).toBe(
        manifest.version,
      );
      const registration = spawnSync(
        process.execPath,
        [
          '--trace-deprecation',
          '--input-type=module',
          '--eval',
          "const { register } = await import('tsx/esm/api'); register();",
        ],
        { cwd: install, encoding: 'utf8' },
      );
      expect(registration.status).toBe(0);
      expect(registration.stderr).not.toContain('DEP0205');
    } finally {
      rmSync(install, { recursive: true, force: true });
    }
  });
});

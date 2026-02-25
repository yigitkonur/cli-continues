/**
 * Cross-platform helpers for spawning processes on Windows vs Unix.
 *
 * On Windows, npm-installed CLIs are `.cmd` shim files that require
 * `shell: true` to execute. The `which` binary doesn't exist — use
 * `where.exe` instead.
 */

export const IS_WINDOWS = process.platform === 'win32';

/** `'where'` on Windows, `'which'` on Unix */
export const WHICH_CMD = IS_WINDOWS ? 'where' : 'which';

/** Spread into `spawn`/`spawnSync` options to enable shell on Windows */
export const SHELL_OPTION: { shell: boolean } | Record<string, never> = IS_WINDOWS
  ? { shell: true }
  : {};

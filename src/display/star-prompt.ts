/**
 * One-time GitHub star prompt shown on first interactive run.
 * Skipped when: no TTY, gh CLI not installed, or already prompted.
 * State persisted in ~/.continues/star-prompt.json.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { SHELL_OPTION } from '../utils/platform.js';
import chalk from 'chalk';
import * as clack from '@clack/prompts';

const REPO = 'yigitkonur/cli-continues';

function statePath(): string {
  return join(homedir(), '.continues', 'star-prompt.json');
}

async function hasBeenPrompted(): Promise<boolean> {
  const p = statePath();
  if (!existsSync(p)) return false;
  try {
    const content = await readFile(p, 'utf-8');
    const state = JSON.parse(content);
    return typeof state.prompted_at === 'string';
  } catch {
    return false;
  }
}

async function markPrompted(): Promise<void> {
  const dir = join(homedir(), '.continues');
  await mkdir(dir, { recursive: true });
  await writeFile(
    statePath(),
    JSON.stringify({ prompted_at: new Date().toISOString() }, null, 2),
  );
}

function isGhInstalled(): boolean {
  const result = spawnSync('gh', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 3000,
    ...SHELL_OPTION,
  });
  return !result.error && result.status === 0;
}

function starRepo(): boolean {
  const result = spawnSync('gh', ['api', '-X', 'PUT', `/user/starred/${REPO}`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 10000,
    ...SHELL_OPTION,
  });
  return !result.error && result.status === 0;
}

export async function maybePromptGithubStar(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  if (await hasBeenPrompted()) return;
  if (!isGhInstalled()) return;

  // Mark before asking so we never re-prompt even if interrupted
  await markPrompted();

  const shouldStar = await clack.confirm({
    message: chalk.hex('#FFD93D')('⭐') + ' ' + chalk.gray('Enjoying continues? Star it on GitHub?'),
    initialValue: true,
  });

  if (clack.isCancel(shouldStar) || !shouldStar) return;

  const ok = starRepo();
  if (ok) {
    clack.log.success(chalk.hex('#00FFC8')('Thanks for the star! 🎉'));
  }
}

import chalk from 'chalk';
import { formatSessionColored } from '../display/format.js';
import type { SessionSource } from '../types/index.js';
import { getSessionsBySource } from '../utils/index.js';
import { nativeResume } from '../utils/resume.js';

/**
 * Resume Nth session from a specific source tool
 */
export async function resumeBySource(source: SessionSource, n: number): Promise<void> {
  try {
    const sessions = await getSessionsBySource(source);

    if (sessions.length === 0) {
      console.log(chalk.yellow(`No ${source} sessions found.`));
      return;
    }

    const index = Math.max(0, Math.min(n - 1, sessions.length - 1));
    const session = sessions[index];

    console.log(chalk.gray(`Resuming ${source} session #${index + 1}:`));
    console.log(formatSessionColored(session));
    console.log();

    if (session.cwd) process.chdir(session.cwd);
    await nativeResume(session);
  } catch (error) {
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exitCode = 1;
  }
}

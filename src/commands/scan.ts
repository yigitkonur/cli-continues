import * as clack from '@clack/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { sourceColors } from '../display/format.js';
import type { SessionSource } from '../types/index.js';
import { getAllSessions } from '../utils/index.js';

/**
 * Scan command - show session discovery stats
 */
export async function scanCommand(options: { rebuild?: boolean }, context: { isTTY: boolean }): Promise<void> {
  try {
    const spinner = context.isTTY ? ora('Scanning session directories...').start() : null;

    const sessions = await getAllSessions(options.rebuild);

    if (spinner) spinner.stop();

    if (context.isTTY) {
      clack.intro(chalk.bold('Session Discovery Statistics'));
    }

    const bySource = sessions.reduce(
      (acc, s) => {
        acc[s.source] = (acc[s.source] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    console.log();
    console.log(chalk.bold(`Total sessions: ${sessions.length}`));
    console.log();

    for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      const colorFn = sourceColors[source as SessionSource] || chalk.white;
      const bar = '\u2588'.repeat(Math.min(50, Math.floor(count / 10)));
      console.log(`${colorFn(source.padEnd(8))}: ${count.toString().padStart(4)} ${chalk.gray(bar)}`);
    }

    if (context.isTTY) {
      console.log();
      clack.outro(chalk.gray('Run "continues" to pick a session'));
    }
  } catch (error) {
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exitCode = 1;
  }
}

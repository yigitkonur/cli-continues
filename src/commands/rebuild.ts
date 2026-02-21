import * as clack from '@clack/prompts';
import chalk from 'chalk';
import { buildIndex } from '../utils/index.js';

/**
 * Rebuild the session index cache
 */
export async function rebuildCommand(context: { isTTY: boolean }): Promise<void> {
  const spinner = context.isTTY ? clack.spinner() : null;

  try {
    if (spinner) {
      spinner.start('Rebuilding session index...');
    }

    const sessions = await buildIndex(true);

    if (spinner) {
      spinner.stop(`Index rebuilt with ${sessions.length} sessions`);
    } else {
      console.log(`Index rebuilt with ${sessions.length} sessions`);
    }

    // Show summary by source
    const bySource = sessions.reduce(
      (acc, s) => {
        acc[s.source] = (acc[s.source] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    for (const [source, count] of Object.entries(bySource)) {
      console.log(chalk.gray(`  ${source}: ${count} sessions`));
    }
  } catch (error) {
    if (spinner) {
      spinner.stop('Failed to rebuild index');
    }
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exitCode = 1;
  }
}

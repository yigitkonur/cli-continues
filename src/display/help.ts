import * as clack from '@clack/prompts';
import chalk from 'chalk';
import { adapters } from '../parsers/registry.js';

/**
 * Show helpful error when no sessions found
 */
export function showNoSessionsHelp(): void {
  clack.log.error('No sessions found.');
  console.log();
  console.log(chalk.gray('Sessions are stored in:'));
  for (const a of Object.values(adapters)) {
    console.log(chalk.gray(`  ${a.storagePath}`));
  }
}

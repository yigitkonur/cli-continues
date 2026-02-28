/**
 * `continues dump <source|all> <directory>` — bulk export sessions to files.
 */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { getPreset, loadConfig } from '../config/index.js';
import type { VerbosityConfig } from '../config/index.js';
import { adapters, ALL_TOOLS } from '../parsers/registry.js';
import type { SessionSource, UnifiedSession } from '../types/index.js';
import { getAllSessions, getSessionsBySource } from '../utils/index.js';

/**
 * Dump sessions to files in a directory.
 */
export async function dumpCommand(
  sourceOrAll: string,
  directory: string,
  options: {
    preset?: string;
    json?: boolean;
    limit?: string;
    rebuild?: boolean;
  },
  context: { isTTY: boolean },
): Promise<void> {
  try {
    // Validate source
    const isAll = sourceOrAll === 'all';
    if (!isAll && !ALL_TOOLS.includes(sourceOrAll as SessionSource)) {
      console.error(chalk.red(`Invalid source: ${sourceOrAll}`));
      console.error(chalk.gray(`Valid sources: all, ${ALL_TOOLS.join(', ')}`));
      process.exitCode = 1;
      return;
    }

    // Get sessions
    const spinner = context.isTTY ? ora('Loading sessions...').start() : null;

    let sessions: UnifiedSession[];
    if (isAll) {
      sessions = await getAllSessions(options.rebuild);
    } else {
      sessions = await getSessionsBySource(sourceOrAll as SessionSource, options.rebuild);
    }

    if (spinner) spinner.stop();

    if (sessions.length === 0) {
      console.log(chalk.yellow('No sessions found.'));
      return;
    }

    // Apply limit
    const limit = options.limit ? parseInt(options.limit, 10) : undefined;
    if (limit && limit > 0) {
      sessions = sessions.slice(0, limit);
    }

    // Create directory (mkdirSync with recursive handles existing dirs)
    const targetDir = path.resolve(directory);
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      console.error(chalk.red(`Failed to create directory: ${targetDir}`));
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }

    // Get preset config
    const presetName = options.preset || 'standard';
    let config: VerbosityConfig;
    try {
      config = getPreset(presetName);
    } catch {
      config = loadConfig();
    }

    // Export sessions
    let successCount = 0;
    let errorCount = 0;
    const startTime = Date.now();
    const successBySource: Record<string, number> = {};

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const progress = `${i + 1}/${sessions.length}`;

      if (context.isTTY) {
        process.stdout.write(`\r${chalk.gray(progress)} Exporting: ${session.source}/${session.id.slice(0, 8)}...`);
      }

      const ext = options.json ? 'json' : 'md';
      const filename = `${session.source}_${session.id}.${ext}`;
      const filepath = path.join(targetDir, filename);

      try {
        if (options.json) {
          // JSON export
          const json = JSON.stringify(session, null, 2);
          fs.writeFileSync(filepath, json, 'utf8');
        } else {
          // Markdown export - reuse adapter's extractContext
          const adapter = adapters[session.source];
          if (!adapter) {
            throw new Error(`No adapter found for source: ${session.source}`);
          }
          const ctx = await adapter.extractContext(session, config);
          fs.writeFileSync(filepath, ctx.markdown, 'utf8');
        }
        successCount++;
        successBySource[session.source] = (successBySource[session.source] || 0) + 1;
      } catch (err) {
        if (!context.isTTY) {
          console.error(chalk.red(`Failed: ${session.id}`), (err as Error).message);
        }
        errorCount++;
      }
    }

    // Clear progress line and print summary
    if (context.isTTY) {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(chalk.green.bold('Dump complete:'));
    console.log(`  Files:     ${successCount} exported`);
    if (errorCount > 0) {
      console.log(`  ${chalk.red(`Errors:     ${errorCount} failed`)}`);
    }
    console.log(`  Directory: ${targetDir}`);
    console.log(`  Time:      ${elapsed}s`);

    // Count by source (only successful exports)
    console.log('\n  By source:');
    for (const [src, count] of Object.entries(successBySource).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${src.padEnd(12)} ${count}`);
    }

    if (errorCount > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exitCode = 1;
  }
}

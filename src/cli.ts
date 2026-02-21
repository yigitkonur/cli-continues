#!/usr/bin/env node

// Suppress experimental warnings (node:sqlite)
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') {
    console.warn(warning);
  }
});

import { createRequire } from 'node:module';
import * as clack from '@clack/prompts';
import { Command } from 'commander';
import { getExtraCommandArgs } from './commands/_shared.js';
import { listCommand } from './commands/list.js';
import { interactivePick } from './commands/pick.js';
import { resumeBySource } from './commands/quick-resume.js';
import { rebuildCommand } from './commands/rebuild.js';
import { resumeCommand } from './commands/resume-cmd.js';
import { scanCommand } from './commands/scan.js';
import { setLogLevel } from './logger.js';
import { ALL_TOOLS, adapters, SOURCE_HELP } from './parsers/registry.js';

function splitTailArgs(args: string[]): { commandArgs: string[]; tailArgs: string[] } {
  const separator = args.indexOf('--');
  if (separator < 0) return { commandArgs: args, tailArgs: [] };
  return {
    commandArgs: args.slice(0, separator),
    tailArgs: args.slice(separator + 1),
  };
}

const rawUserArgs = process.argv.slice(2);
const { commandArgs, tailArgs } = splitTailArgs(rawUserArgs);

const program = new Command();
const _require = createRequire(import.meta.url);
const { version: VERSION } = _require('../package.json') as { version: string };

// Detect TTY for interactive mode
const isTTY = !!process.stdout.isTTY;
const supportsColor = !process.env.NO_COLOR && isTTY;
const cliContext = { isTTY, supportsColor, version: VERSION };

// Signal handling for graceful exits
let isExiting = false;

process.on('SIGINT', () => {
  if (!isExiting) {
    isExiting = true;
    if (isTTY) {
      clack.cancel('Cancelled by user');
    } else {
      console.log('\nCancelled.');
    }
    process.exitCode = 1;
  }
});

process.on('SIGTERM', () => {
  if (!isExiting) {
    isExiting = true;
    process.exitCode = 0;
  }
});

/**
 * Configure CLI program
 */
program
  .name('continues')
  .description(
    'Never lose context. Resume any AI coding session across Claude, Copilot, Gemini, Codex, OpenCode, Droid & Cursor.',
  )
  .version(VERSION)
  .option('--verbose', 'Show info-level logs')
  .option('--debug', 'Show debug-level logs')
  .helpOption('-h, --help', 'Display help for command')
  .hook('preAction', () => {
    const opts = program.opts();
    if (opts.debug) setLogLevel('debug');
    else if (opts.verbose) setLogLevel('info');
  })
  .addHelpText(
    'after',
    `
Examples:
  $ continues                      # Interactive TUI picker
  $ continues list                 # List all sessions
  $ continues list --source claude # Filter by source
  $ continues list --json          # JSON output for scripting
  $ continues resume abc123        # Resume by ID
  $ continues resume abc123 --in gemini  # Cross-tool handoff
  $ continues scan                 # Show session discovery stats

Short aliases:
  cont (binary alias)
  ls   -> list
  r    -> resume
`,
  );

// Default command - Interactive TUI
program.option('-a, --all', 'Show all sessions globally (skip directory filtering)').action(async (options) => {
  await interactivePick({ all: options.all, forwardArgs: tailArgs }, cliContext);
});

// Pick command (explicit TUI)
program
  .command('pick')
  .description('Interactive session picker (TUI mode)')
  .option('-s, --source <source>', SOURCE_HELP)
  .option('-a, --all', 'Show all sessions globally (skip directory filtering)')
  .option('--no-tui', 'Disable TUI, use plain text')
  .option('--rebuild', 'Force rebuild session index')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (options, command: Command) => {
    const rawForwardArgs = getExtraCommandArgs(command, 0);
    await interactivePick({ ...options, forwardArgs: [...rawForwardArgs, ...tailArgs] }, cliContext);
  });

// List sessions command
program
  .command('list')
  .alias('ls')
  .description('List all sessions in table format')
  .option('-s, --source <source>', SOURCE_HELP)
  .option('-n, --limit <number>', 'Limit number of sessions', '50')
  .option('--json', 'Output as JSON array')
  .option('--jsonl', 'Output as JSONL')
  .option('--rebuild', 'Force rebuild session index')
  .action(async (options) => {
    await listCommand(options, cliContext);
  });

// Resume a specific session
program
  .command('resume <session-id>')
  .alias('r')
  .description('Resume a session by ID or short ID')
  .option('-i, --in <cli-tool>', `Target CLI tool (${ALL_TOOLS.join(', ')})`)
  .option('--reference', 'Use file reference instead of inline context (for very large sessions)')
  .option('--no-tui', 'Disable interactive prompts')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (sessionId, options, command: Command) => {
    const rawForwardArgs = getExtraCommandArgs(command, 1);
    await resumeCommand(sessionId, options, cliContext, { rawArgs: rawForwardArgs, tailArgs });
  });

// Scan command
program
  .command('scan')
  .description('Show session discovery statistics')
  .option('--rebuild', 'Force rebuild session index')
  .action(async (options) => {
    await scanCommand(options, cliContext);
  });

// Rebuild the session index
program
  .command('rebuild')
  .description('Force rebuild the session index cache')
  .action(async () => {
    await rebuildCommand(cliContext);
  });

// Quick resume commands for each tool — generated from the adapter registry
for (const tool of ALL_TOOLS) {
  const adapter = adapters[tool];
  program
    .command(`${tool} [n]`)
    .description(`Resume Nth newest ${adapter.label} session (default: 1)`)
    .action(async (n = '1') => {
      await resumeBySource(tool, parseInt(n, 10));
    });
}

// Parse and run
program.parse([process.argv[0], process.argv[1], ...commandArgs]);

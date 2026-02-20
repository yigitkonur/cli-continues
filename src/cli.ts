#!/usr/bin/env node

// Suppress experimental warnings (node:sqlite)
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') {
    console.warn(warning);
  }
});

import { Command } from 'commander';
import chalk from 'chalk';
import * as clack from '@clack/prompts';
import ora from 'ora';
import type { UnifiedSession, SessionSource } from './types/index.js';
import {
  getAllSessions,
  getSessionsBySource,
  findSession,
  formatSession,
  buildIndex,
  sessionsToJsonl,
} from './utils/index.js';
import {
  resume,
  nativeResume,
  crossToolResume,
  getAvailableTools,
  getResumeCommand,
} from './utils/resume.js';

const program = new Command();
const VERSION = '2.7.0';

// Detect TTY for interactive mode
const isTTY = process.stdout.isTTY;

// Color support detection
const supportsColor = !process.env.NO_COLOR && isTTY;

/**
 * ASCII art banner with highlighted 's' (the "continues" brand mark)
 */
function showBanner(): void {
  if (!supportsColor) return;
  const dim = chalk.gray;
  const hi = chalk.cyan.bold;
  console.log();
  console.log(dim('  ┌─────────────────────────────────────┐'));
  console.log(dim('  │  ') + chalk.bold('continue') + hi('s') + dim('                           │'));
  console.log(dim('  │  ') + chalk.gray(`v${VERSION} — pick up where you left off`) + dim('  │'));
  console.log(dim('  └─────────────────────────────────────┘'));
  console.log();
}

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
 * Source-specific colors for consistent branding
 */
const sourceColors: Record<SessionSource, (s: string) => string> = {
  claude: chalk.blue,
  copilot: chalk.green,
  gemini: chalk.cyan,
  codex: chalk.magenta,
  opencode: chalk.yellow,
  droid: chalk.red,
};

/**
 * Format session with colors in columnar layout
 * Format: [source]  YYYY-MM-DD HH:MM  project-name  summary...  short-id
 */
function formatSessionColored(session: UnifiedSession): string {
  const colorFn = sourceColors[session.source] || chalk.white;
  const tag = `[${session.source}]`;
  const source = colorFn(tag.padEnd(10));
  
  const date = chalk.gray(session.updatedAt.toISOString().slice(0, 16).replace('T', ' '));
  
  // Show repo or last folder of cwd
  const repoDisplay = session.repo || session.cwd.split('/').slice(-2).join('/') || '';
  const repo = chalk.cyan(repoDisplay.slice(0, 20).padEnd(20));
  
  // Summary - truncate nicely
  const summaryText = session.summary || '(no summary)';
  const summary = (session.summary ? chalk.white(summaryText.slice(0, 44)) : chalk.gray(summaryText)).padEnd(44);
  
  // Short ID
  const id = chalk.gray(session.id.slice(0, 8));
  
  return `${source} ${date}  ${repo}  ${summary}  ${id}`;
}

/**
 * Format session for clack select - simpler, cleaner
 */
function formatSessionForSelect(session: UnifiedSession): string {
  const colorFn = sourceColors[session.source] || chalk.white;
  const tag = `[${session.source}]`;
  const source = colorFn(tag.padEnd(10));
  const date = session.updatedAt.toISOString().slice(0, 16).replace('T', ' ');
  const repoDisplay = session.repo || session.cwd.split('/').slice(-1)[0] || '';
  const summary = (session.summary || '(no summary)').slice(0, 48);
  
  return `${source}  ${date}  ${chalk.cyan(repoDisplay.padEnd(20))}  ${summary}`;
}

/**
 * Show session discovery stats
 */
function showSessionStats(sessions: UnifiedSession[]): void {
  const bySource = sessions.reduce((acc, s) => {
    acc[s.source] = (acc[s.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const cliTools = Object.keys(bySource).length;
  const total = sessions.length;
  
  console.log(chalk.gray(`  Found ${total} sessions across ${cliTools} CLI tool${cliTools !== 1 ? 's' : ''}`));
  
  // Show breakdown
  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    const colorFn = sourceColors[source as SessionSource] || chalk.white;
    console.log(chalk.gray(`  ${colorFn(source)}: ${count}`));
  }
}

/**
 * Show helpful error when no sessions found
 */
function showNoSessionsHelp(): void {
  clack.log.error('No sessions found.');
  console.log();
  console.log(chalk.gray('Sessions are stored in:'));
  console.log(chalk.gray('  ~/.codex/sessions/'));
  console.log(chalk.gray('  ~/.claude/projects/'));
  console.log(chalk.gray('  ~/.copilot/session-state/'));
  console.log(chalk.gray('  ~/.gemini/tmp/*/chats/'));
  console.log(chalk.gray('  ~/.local/share/opencode/storage/'));
  console.log(chalk.gray('  ~/.factory/sessions/'));
}

/**
 * Main interactive TUI command
 */
async function interactivePick(options: { source?: string; noTui?: boolean; rebuild?: boolean }): Promise<void> {
  try {
    // If not TTY or --no-tui, fall back to list
    if (!isTTY || options.noTui) {
      console.log(chalk.yellow('Interactive mode requires a TTY. Use "continues list" instead.'));
      process.exitCode = 1;
      return;
    }

    showBanner();
    clack.intro(chalk.bold('continue') + chalk.cyan.bold('s') + chalk.gray(' — session picker'));

    const s = clack.spinner();
    s.start('Loading sessions...');
    
    let sessions: UnifiedSession[];
    if (options.source) {
      sessions = await getSessionsBySource(options.source as SessionSource, options.rebuild);
    } else {
      sessions = await getAllSessions(options.rebuild);
    }

    s.stop();

    if (sessions.length === 0) {
      showNoSessionsHelp();
      clack.outro(chalk.gray('No sessions to resume'));
      return;
    }

    // Check for sessions matching current working directory
    const currentDir = process.cwd();
    const cwdSessions = sessions.filter(sess => sess.cwd === currentDir);
    const otherSessions = sessions.filter(sess => sess.cwd !== currentDir);
    const hasCwdSessions = cwdSessions.length > 0;

    if (hasCwdSessions) {
      console.log(chalk.gray(`  ${chalk.green('▸')} ${cwdSessions.length} session${cwdSessions.length !== 1 ? 's' : ''} found in current directory`));
    } else {
      console.log(chalk.gray(`  No sessions found for ${chalk.cyan(currentDir.split('/').slice(-2).join('/'))}`));
      console.log(chalk.gray(`  Showing all sessions instead`));
    }

    // Show stats
    showSessionStats(sessions);
    console.log();

    // Step 1: Filter by CLI tool (optional) — skip if source already specified
    let filteredSessions = sessions;
    
    if (!options.source && sessions.length > 0) {
      const bySource = sessions.reduce((acc, s) => {
        acc[s.source] = (acc[s.source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const filterOptions: { value: string; label: string }[] = [];
      
      // If we have cwd sessions, offer "This directory" as first option
      if (hasCwdSessions) {
        filterOptions.push({
          value: 'cwd',
          label: `This directory (${cwdSessions.length} session${cwdSessions.length !== 1 ? 's' : ''})`,
        });
      }

      filterOptions.push(
        { value: 'all', label: `All CLI tools (${sessions.length} sessions)` },
        ...Object.entries(bySource)
          .sort((a, b) => b[1] - a[1])
          .map(([source, count]) => ({
            value: source,
            label: `${sourceColors[source as SessionSource](source.charAt(0).toUpperCase() + source.slice(1))} (${count})`,
          })),
      );

      const toolFilter = await clack.select({
        message: 'Filter sessions',
        options: filterOptions,
        initialValue: hasCwdSessions ? 'cwd' : undefined,
      });

      if (clack.isCancel(toolFilter)) {
        clack.cancel('Cancelled');
        return;
      }

      if (toolFilter === 'cwd') {
        filteredSessions = cwdSessions;
      } else if (toolFilter !== 'all') {
        filteredSessions = sessions.filter(s => s.source === toolFilter);
      }
    }

    // Step 2: Select session — show all with scrolling (maxItems controls viewport)
    const PAGE_SIZE = 500;
    const sessionOptions = filteredSessions.slice(0, PAGE_SIZE).map(s => ({
      value: s,
      label: formatSessionForSelect(s),
      hint: s.id.slice(0, 8),
    }));

    if (filteredSessions.length > PAGE_SIZE) {
      clack.log.info(chalk.gray(`Showing first ${PAGE_SIZE} of ${filteredSessions.length} sessions. Use --source to narrow results.`));
    }

    const selectedSession = await clack.select({
      message: `Select a session (${filteredSessions.length} available)`,
      options: sessionOptions,
      maxItems: 15,
    });

    if (clack.isCancel(selectedSession)) {
      clack.cancel('Cancelled');
      return;
    }

    const session = selectedSession as UnifiedSession;

    // Step 3: Select target tool
    const availableTools = await getAvailableTools();
    
    const targetOptions = availableTools
        .filter(t => t !== session.source)
        .map(t => ({
          value: t,
          label: `${sourceColors[t](t.charAt(0).toUpperCase() + t.slice(1))}`,
        }));

    if (targetOptions.length === 0) {
      const allTools: SessionSource[] = ['claude', 'codex', 'copilot', 'gemini', 'opencode', 'droid'];
      const missing = allTools.filter(t => !availableTools.includes(t)).map(t => t.charAt(0).toUpperCase() + t.slice(1));
      clack.log.warn(`Only ${sourceColors[session.source](session.source)} is installed. Install at least one more (${missing.join(', ')}) to enable cross-tool handoff.`);
      return;
    }

    const targetTool = await clack.select({
      message: `Continue ${sourceColors[session.source](session.source)} session in:`,
      options: targetOptions,
    }) as SessionSource;

    if (clack.isCancel(targetTool)) {
      clack.cancel('Cancelled');
      return;
    }

    // Step 4: Show what will happen and resume
    console.log();
    clack.log.info(`Working directory: ${chalk.cyan(session.cwd)}`);
    
    const messageCount = (session as any).messageCount || '?';
    const fileCount = (session as any).filesModified?.length || '?';
    clack.log.info(`Context: ${messageCount} messages, ${fileCount} files modified`);
    clack.log.info(`Command: ${chalk.cyan(getResumeCommand(session, targetTool))}`);
    console.log();

    clack.log.step(`Handing off to ${targetTool}...`);
    clack.outro(`Launching ${targetTool}`);

    // Change to session's working directory and resume
    process.chdir(session.cwd);
    await resume(session, targetTool);

  } catch (error) {
    if (clack.isCancel(error)) {
      clack.cancel('Cancelled');
      return;
    }
    clack.log.error(`${(error as Error).message}`);
    process.exitCode = 1;
  }
}

/**
 * Configure CLI program
 */
program
  .name('continues')
  .description('Never lose context. Resume any AI coding session across Claude, Copilot, Gemini, Codex, OpenCode & Droid.')
  .version(VERSION)
  .helpOption('-h, --help', 'Display help for command')
  .addHelpText('after', `
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
`);

/**
 * Default command - Interactive TUI
 */
program
  .action(async () => {
    await interactivePick({});
  });

/**
 * Pick command (explicit TUI)
 */
program
  .command('pick')
  .description('Interactive session picker (TUI mode)')
  .option('-s, --source <source>', 'Filter by source (claude, copilot, gemini, codex, opencode, droid)')
  .option('--no-tui', 'Disable TUI, use plain text')
  .option('--rebuild', 'Force rebuild session index')
  .action(async (options) => {
    await interactivePick(options);
  });

/**
 * List sessions command
 */
program
  .command('list')
  .alias('ls')
  .description('List all sessions in table format')
  .option('-s, --source <source>', 'Filter by source (claude, copilot, gemini, codex, opencode, droid)')
  .option('-n, --limit <number>', 'Limit number of sessions', '50')
  .option('--json', 'Output as JSON array')
  .option('--jsonl', 'Output as JSONL')
  .option('--rebuild', 'Force rebuild session index')
  .action(async (options) => {
    try {
      // Use simple spinner for non-interactive
      const spinner = isTTY && !options.json && !options.jsonl 
        ? ora('Loading sessions...').start() 
        : null;
      
      let sessions: UnifiedSession[];
      if (options.source) {
        sessions = await getSessionsBySource(options.source as SessionSource, options.rebuild);
      } else {
        sessions = await getAllSessions(options.rebuild);
      }

      if (spinner) spinner.stop();

      const limit = parseInt(options.limit, 10);
      const displaySessions = sessions.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify(displaySessions, null, 2));
        return;
      }

      if (options.jsonl) {
        console.log(sessionsToJsonl(displaySessions));
        return;
      }

      if (sessions.length === 0) {
        if (isTTY) {
          showNoSessionsHelp();
        } else {
          console.log('No sessions found.');
        }
        return;
      }

      // Print header
      console.log(chalk.gray(`Found ${sessions.length} sessions (showing ${displaySessions.length}):`));
      console.log();

      for (const session of displaySessions) {
        console.log(formatSessionColored(session));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exitCode = 1;
    }
  });

/**
 * Resume a specific session
 */
program
  .command('resume <session-id>')
  .alias('r')
  .description('Resume a session by ID or short ID')
  .option('-i, --in <cli-tool>', 'Target CLI tool (claude, copilot, gemini, codex, opencode, droid)')
  .option('--reference', 'Use file reference instead of inline context (for very large sessions)')
  .option('--no-tui', 'Disable interactive prompts')
  .action(async (sessionId, options) => {
    try {
      const spinner = isTTY && !options.noTui ? ora('Finding session...').start() : null;
      const session = await findSession(sessionId);
      if (spinner) spinner.stop();

      if (!session) {
        // Try to find similar sessions
        const allSessions = await getAllSessions();
        const similar = allSessions.filter(s => 
          s.id.toLowerCase().includes(sessionId.toLowerCase()) ||
          s.summary?.toLowerCase().includes(sessionId.toLowerCase())
        ).slice(0, 3);

        console.error(chalk.red(`Session not found: ${sessionId}`));
        
        if (similar.length > 0) {
          console.log(chalk.yellow('\nDid you mean one of these?'));
          for (const s of similar) {
            console.log('  ' + formatSessionColored(s));
          }
        }
        
        process.exitCode = 1;
        return;
      }

      const target = options.in as SessionSource | undefined;
      const mode = options.reference ? 'reference' as const : 'inline' as const;

      // In non-interactive mode, just resume directly
      if (!isTTY || options.noTui) {
        console.log(chalk.gray('Session: ') + formatSession(session));
        console.log(chalk.gray('Command: ') + chalk.cyan(getResumeCommand(session, target)));
        console.log();

        process.chdir(session.cwd);
        await resume(session, target, mode);
        return;
      }

      // Interactive mode - show details and prompt for target if not specified
      if (isTTY && !target) {
        clack.intro(chalk.bold('Resume session'));
        
        console.log(formatSessionColored(session));
        console.log();

        const availableTools = await getAvailableTools();
        
        const targetOptions = availableTools
          .filter(t => t !== session.source)
          .map(t => ({
            value: t,
            label: `${sourceColors[t](t.charAt(0).toUpperCase() + t.slice(1))}`,
          }));

        if (targetOptions.length === 0) {
          const allTools: SessionSource[] = ['claude', 'codex', 'copilot', 'gemini', 'opencode', 'droid'];
          const missing = allTools.filter(t => !availableTools.includes(t)).map(t => t.charAt(0).toUpperCase() + t.slice(1));
          clack.log.warn(`Only ${sourceColors[session.source](session.source)} is installed. Install at least one more (${missing.join(', ')}) to enable cross-tool handoff.`);
          return;
        }

        const selectedTarget = await clack.select({
          message: `Continue ${sourceColors[session.source](session.source)} session in:`,
          options: targetOptions,
        }) as SessionSource;

        if (clack.isCancel(selectedTarget)) {
          clack.cancel('Cancelled');
          return;
        }

        clack.log.step(`Handing off to ${selectedTarget}...`);
        clack.outro(`Launching ${selectedTarget}`);

        process.chdir(session.cwd);
        await resume(session, selectedTarget, mode);
      } else {
        // Target specified, just resume
        console.log(chalk.gray('Session: ') + formatSession(session));
        console.log(chalk.gray('Command: ') + chalk.cyan(getResumeCommand(session, target)));
        console.log();

        process.chdir(session.cwd);
        await resume(session, target, mode);
      }

    } catch (error) {
      if (clack.isCancel(error)) {
        clack.cancel('Cancelled');
        return;
      }
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exitCode = 1;
    }
  });

/**
 * Scan command - show session discovery stats
 */
program
  .command('scan')
  .description('Show session discovery statistics')
  .option('--rebuild', 'Force rebuild session index')
  .action(async (options) => {
    try {
      const spinner = isTTY ? ora('Scanning session directories...').start() : null;
      
      const sessions = await getAllSessions(options.rebuild);
      
      if (spinner) spinner.stop();

      if (isTTY) {
        clack.intro(chalk.bold('Session Discovery Statistics'));
      }

      const bySource = sessions.reduce((acc, s) => {
        acc[s.source] = (acc[s.source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log();
      console.log(chalk.bold(`Total sessions: ${sessions.length}`));
      console.log();

      for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
        const colorFn = sourceColors[source as SessionSource] || chalk.white;
        const bar = '█'.repeat(Math.min(50, Math.floor(count / 10)));
        console.log(`${colorFn(source.padEnd(8))}: ${count.toString().padStart(4)} ${chalk.gray(bar)}`);
      }

      if (isTTY) {
        console.log();
        clack.outro(chalk.gray('Run "continues" to pick a session'));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), (error as Error).message);
      process.exitCode = 1;
    }
  });

/**
 * Rebuild the session index
 */
program
  .command('rebuild')
  .description('Force rebuild the session index cache')
  .action(async () => {
    const spinner = isTTY ? clack.spinner() : null;
    
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
      const bySource = sessions.reduce((acc, s) => {
        acc[s.source] = (acc[s.source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

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
  });

/**
 * Quick resume commands for each tool
 */
program
  .command('claude [n]')
  .description('Resume Nth newest Claude session (default: 1)')
  .action(async (n = '1') => {
    await resumeBySource('claude', parseInt(n, 10));
  });

program
  .command('copilot [n]')
  .description('Resume Nth newest Copilot session (default: 1)')
  .action(async (n = '1') => {
    await resumeBySource('copilot', parseInt(n, 10));
  });

program
  .command('gemini [n]')
  .description('Resume Nth newest Gemini session (default: 1)')
  .action(async (n = '1') => {
    await resumeBySource('gemini', parseInt(n, 10));
  });

program
  .command('codex [n]')
  .description('Resume Nth newest Codex session (default: 1)')
  .action(async (n = '1') => {
    await resumeBySource('codex', parseInt(n, 10));
  });

program
  .command('opencode [n]')
  .description('Resume Nth newest OpenCode session (default: 1)')
  .action(async (n = '1') => {
    await resumeBySource('opencode', parseInt(n, 10));
  });

program
  .command('droid [n]')
  .description('Resume Nth newest Droid session (default: 1)')
  .action(async (n = '1') => {
    await resumeBySource('droid', parseInt(n, 10));
  });

/**
 * Helper to resume Nth session from a source
 */
async function resumeBySource(source: SessionSource, n: number): Promise<void> {
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

    process.chdir(session.cwd);
    await nativeResume(session);
  } catch (error) {
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exitCode = 1;
  }
}

// Parse and run
program.parse();

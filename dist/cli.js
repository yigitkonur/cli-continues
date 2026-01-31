#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { getAllSessions, getSessionsBySource, findSession, formatSession, buildIndex, sessionsToJsonl, } from './utils/index.js';
import { resume, nativeResume, getAvailableTools, getResumeCommand, } from './utils/resume.js';
const program = new Command();
program
    .name('continues')
    .description('Never lose context. Resume any AI coding session across Codex, Claude, Copilot, Gemini & OpenCode.')
    .version('1.0.0');
/**
 * Main interactive picker command
 */
program
    .command('pick', { isDefault: true })
    .description('Interactive session picker with cross-tool resume')
    .option('-s, --source <source>', 'Filter by source (codex, claude, copilot, gemini, opencode)')
    .option('-n, --limit <number>', 'Limit number of sessions shown', '50')
    .option('--rebuild', 'Force rebuild session index')
    .action(async (options) => {
    try {
        const spinner = ora('Loading sessions...').start();
        let sessions;
        if (options.source) {
            sessions = await getSessionsBySource(options.source, options.rebuild);
        }
        else {
            sessions = await getAllSessions(options.rebuild);
        }
        spinner.stop();
        if (sessions.length === 0) {
            console.log(chalk.yellow('No sessions found.'));
            console.log(chalk.gray('Sessions are stored in:'));
            console.log(chalk.gray('  ~/.codex/sessions/'));
            console.log(chalk.gray('  ~/.claude/projects/'));
            console.log(chalk.gray('  ~/.copilot/session-state/'));
            console.log(chalk.gray('  ~/.gemini/tmp/*/chats/'));
            console.log(chalk.gray('  ~/.local/share/opencode/storage/'));
            return;
        }
        const limit = parseInt(options.limit, 10);
        const displaySessions = sessions.slice(0, limit);
        // Step 1: Select session
        const sessionChoices = displaySessions.map(s => ({
            name: formatSessionColored(s),
            value: s,
            short: `${s.source}:${s.id.slice(0, 8)}`,
        }));
        const { selectedSession } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selectedSession',
                message: 'Select a session to resume:',
                choices: sessionChoices,
                pageSize: 15,
                loop: false,
            },
        ]);
        // Step 2: Select target tool
        const availableTools = await getAvailableTools();
        const targetChoices = [
            {
                name: `${chalk.green('▶')} Continue in ${chalk.bold(selectedSession.source)} ${chalk.gray('(original - fastest)')}`,
                value: selectedSession.source,
            },
            ...availableTools
                .filter(t => t !== selectedSession.source)
                .map(t => ({
                name: `  Continue in ${chalk.bold(t)} ${chalk.gray('(cross-tool injection)')}`,
                value: t,
            })),
        ];
        const { targetTool } = await inquirer.prompt([
            {
                type: 'list',
                name: 'targetTool',
                message: 'Select target tool:',
                choices: targetChoices,
            },
        ]);
        // Show what will happen
        console.log();
        console.log(chalk.gray('Command: ') + chalk.cyan(getResumeCommand(selectedSession, targetTool)));
        console.log(chalk.gray('Working directory: ') + chalk.cyan(selectedSession.cwd));
        console.log();
        // Change to session's working directory and resume
        process.chdir(selectedSession.cwd);
        await resume(selectedSession, targetTool);
    }
    catch (error) {
        if (error.message?.includes('User force closed')) {
            console.log(chalk.gray('\nCancelled.'));
            return;
        }
        console.error(chalk.red('Error:'), error);
        process.exit(1);
    }
});
/**
 * List sessions command
 */
program
    .command('list')
    .alias('ls')
    .description('List all sessions')
    .option('-s, --source <source>', 'Filter by source (codex, claude, copilot, gemini, opencode)')
    .option('-n, --limit <number>', 'Limit number of sessions', '20')
    .option('--json', 'Output as JSON')
    .option('--jsonl', 'Output as JSONL')
    .option('--rebuild', 'Force rebuild session index')
    .action(async (options) => {
    try {
        const spinner = ora('Loading sessions...').start();
        let sessions;
        if (options.source) {
            sessions = await getSessionsBySource(options.source, options.rebuild);
        }
        else {
            sessions = await getAllSessions(options.rebuild);
        }
        spinner.stop();
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
            console.log(chalk.yellow('No sessions found.'));
            return;
        }
        // Print header
        console.log(chalk.gray(`Found ${sessions.length} sessions (showing ${displaySessions.length}):`));
        console.log();
        for (const session of displaySessions) {
            console.log(formatSessionColored(session));
        }
    }
    catch (error) {
        console.error(chalk.red('Error:'), error);
        process.exit(1);
    }
});
/**
 * Resume a specific session
 */
program
    .command('resume <session-id>')
    .alias('r')
    .description('Resume a session by ID')
    .option('-t, --target <tool>', 'Target tool (codex, claude, copilot)')
    .action(async (sessionId, options) => {
    try {
        const spinner = ora('Finding session...').start();
        const session = await findSession(sessionId);
        spinner.stop();
        if (!session) {
            console.error(chalk.red(`Session not found: ${sessionId}`));
            process.exit(1);
        }
        const target = options.target;
        console.log(chalk.gray('Session: ') + chalk.cyan(formatSession(session)));
        console.log(chalk.gray('Command: ') + chalk.cyan(getResumeCommand(session, target)));
        console.log();
        process.chdir(session.cwd);
        await resume(session, target);
    }
    catch (error) {
        console.error(chalk.red('Error:'), error);
        process.exit(1);
    }
});
/**
 * Rebuild the session index
 */
program
    .command('rebuild')
    .description('Force rebuild the session index')
    .action(async () => {
    const spinner = ora('Rebuilding session index...').start();
    try {
        const sessions = await buildIndex(true);
        spinner.succeed(`Index rebuilt with ${sessions.length} sessions`);
        // Show summary by source
        const bySource = sessions.reduce((acc, s) => {
            acc[s.source] = (acc[s.source] || 0) + 1;
            return acc;
        }, {});
        for (const [source, count] of Object.entries(bySource)) {
            console.log(chalk.gray(`  ${source}: ${count} sessions`));
        }
    }
    catch (error) {
        spinner.fail('Failed to rebuild index');
        console.error(chalk.red('Error:'), error);
        process.exit(1);
    }
});
/**
 * Quick resume commands for each tool
 */
program
    .command('codex [n]')
    .description('Resume Nth newest Codex session (default: 1)')
    .action(async (n = '1') => {
    await resumeBySource('codex', parseInt(n, 10));
});
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
    .command('opencode [n]')
    .description('Resume Nth newest OpenCode session (default: 1)')
    .action(async (n = '1') => {
    await resumeBySource('opencode', parseInt(n, 10));
});
/**
 * Helper to resume Nth session from a source
 */
async function resumeBySource(source, n) {
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
}
/**
 * Format session with colors - improved layout
 */
function formatSessionColored(session) {
    const sourceColors = {
        codex: chalk.magenta,
        claude: chalk.blue,
        copilot: chalk.green,
        gemini: chalk.cyan,
        opencode: chalk.yellow,
    };
    const colorFn = sourceColors[session.source] || chalk.white;
    const source = colorFn(`[${session.source}]`.padEnd(10));
    const date = chalk.gray(session.updatedAt.toISOString().slice(0, 16).replace('T', ' '));
    // Show repo or last folder of cwd
    const repoDisplay = session.repo || session.cwd.split('/').slice(-2).join('/') || '';
    const repo = chalk.cyan(repoDisplay.slice(0, 24).padEnd(24));
    // Branch display
    const branch = session.branch ? chalk.yellow(session.branch.slice(0, 10).padEnd(10)) : ''.padEnd(10);
    // Summary - truncate nicely
    const summaryText = session.summary || chalk.gray('(no summary)');
    const summary = (session.summary ? chalk.white(summaryText) : summaryText).slice(0, 38).padEnd(38);
    // Short ID
    const id = chalk.gray(session.id.slice(0, 11));
    return `${source} ${date}  ${repo} ${branch} ${summary} ${id}`;
}
// Parse and run
program.parse();
//# sourceMappingURL=cli.js.map
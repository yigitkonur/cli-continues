import * as clack from '@clack/prompts';
import chalk from 'chalk';
import { showBanner } from '../display/banner.js';
import { formatSessionForSelect, sourceColors } from '../display/format.js';
import { showNoSessionsHelp } from '../display/help.js';
import type { SessionSource, UnifiedSession } from '../types/index.js';
import type { HandoffForwardingOptions } from '../utils/forward-flags.js';
import { getAllSessions, getSessionsBySource } from '../utils/index.js';
import { getResumeCommand, nativeResume, resolveCrossToolForwarding, resume } from '../utils/resume.js';
import { matchesCwd } from '../utils/slug.js';
import { checkSingleToolAutoResume, selectTargetTool, showForwardingWarnings } from './_shared.js';

/**
 * Main interactive TUI command
 */
export async function interactivePick(
  options: { source?: string; noTui?: boolean; rebuild?: boolean; all?: boolean; forwardArgs?: string[] },
  context: { isTTY: boolean; supportsColor: boolean; version: string },
): Promise<void> {
  try {
    // If not TTY or --no-tui, fall back to list
    if (!context.isTTY || options.noTui) {
      console.log(chalk.yellow('Interactive mode requires a TTY. Use "continues list" instead.'));
      process.exitCode = 1;
      return;
    }

    showBanner(context.version, context.supportsColor);
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

    // Check for sessions matching current working directory (includes subdirectories)
    const currentDir = process.cwd();
    const cwdSessions = options.all ? [] : sessions.filter((sess) => matchesCwd(sess.cwd, currentDir));
    const hasCwdSessions = cwdSessions.length > 0;

    const dirName = currentDir.split('/').pop() || currentDir;

    if (!options.all && !hasCwdSessions && sessions.length > 0) {
      clack.log.info(chalk.gray(`No sessions in ${dirName}, showing all`));
    }

    // Auto-resume: if exactly 1 session matches cwd, skip picker
    if (cwdSessions.length === 1 && !options.source) {
      const session = cwdSessions[0];
      console.log(chalk.gray(`  Auto-selected the only matching session:`));
      console.log(`  ${formatSessionForSelect(session)}`);
      console.log();

      if (await checkSingleToolAutoResume(session, nativeResume)) return;

      const targetTool = await selectTargetTool(session, { excludeSource: false });
      if (!targetTool) return;

      const forwarding: HandoffForwardingOptions | undefined =
        targetTool !== session.source ? { tailArgs: options.forwardArgs } : undefined;

      if (forwarding) {
        const resolved = resolveCrossToolForwarding(targetTool, forwarding);
        await showForwardingWarnings(resolved.warnings, context);
      }

      console.log();
      clack.log.info(`Working directory: ${chalk.cyan(session.cwd)}`);
      clack.log.info(`Command: ${chalk.cyan(getResumeCommand(session, targetTool, forwarding))}`);
      console.log();
      clack.log.step(`Handing off to ${targetTool}...`);
      clack.outro(`Launching ${targetTool}`);

      if (session.cwd) process.chdir(session.cwd);
      await resume(session, targetTool, 'inline', forwarding);
      return;
    }

    // Step 1: Filter by CLI tool (optional) -- skip if source already specified
    let filteredSessions = hasCwdSessions ? cwdSessions : sessions;

    if (!options.source && sessions.length > 0) {
      let scope: 'cwd' | 'all' = hasCwdSessions ? 'cwd' : 'all';

      while (true) {
        const pool = scope === 'cwd' ? cwdSessions : sessions;
        const bySource = pool.reduce(
          (acc, sess) => {
            acc[sess.source] = (acc[sess.source] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );
        const toolCount = Object.keys(bySource).length;

        // Select message conveys scope context
        let message: string;
        if (scope === 'cwd') {
          message = `${dirName} — ${pool.length} session${pool.length !== 1 ? 's' : ''}`;
        } else if (hasCwdSessions) {
          message = `All sessions — ${pool.length} total`;
        } else {
          message = `${pool.length} sessions across ${toolCount} tool${toolCount !== 1 ? 's' : ''}`;
        }

        // Build options: tool names first, then "All tools", then scope toggle
        const filterOptions: { value: string; label: string; hint?: string }[] = [];

        // Per-tool options (sorted by count desc, colored)
        filterOptions.push(
          ...Object.entries(bySource)
            .sort((a, b) => b[1] - a[1])
            .map(([source, count]) => ({
              value: source,
              label: `${sourceColors[source as SessionSource](source.charAt(0).toUpperCase() + source.slice(1))} (${count})`,
            })),
        );

        // "All tools" -- no tool filter, shows all sessions in current scope
        filterOptions.push({
          value: 'all-in-scope',
          label: `All tools (${pool.length})`,
        });

        // Scope toggle (only when CWD sessions exist and --all wasn't used)
        if (hasCwdSessions && !options.all) {
          if (scope === 'cwd') {
            filterOptions.push({
              value: 'scope-toggle',
              label: chalk.dim(`Show all sessions (${sessions.length})`),
            });
          } else {
            filterOptions.push({
              value: 'scope-toggle',
              label: chalk.dim(`This directory (${cwdSessions.length})`),
            });
          }
        }

        const toolFilter = await clack.select({
          message,
          options: filterOptions,
          initialValue: 'all-in-scope',
        });

        if (clack.isCancel(toolFilter)) {
          clack.cancel('Cancelled');
          return;
        }

        // Scope toggle: flip and re-render
        if (toolFilter === 'scope-toggle') {
          scope = scope === 'cwd' ? 'all' : 'cwd';
          continue;
        }

        // "All tools": use entire pool
        if (toolFilter === 'all-in-scope') {
          filteredSessions = pool;
          break;
        }

        // Specific tool: filter by source
        filteredSessions = pool.filter((sess) => sess.source === toolFilter);
        break;
      }
    }

    // Step 2: Select session -- show all with scrolling (maxItems controls viewport)
    const PAGE_SIZE = 500;
    const sessionOptions = filteredSessions.slice(0, PAGE_SIZE).map((sess) => ({
      value: sess,
      label: formatSessionForSelect(sess),
      hint: sess.id.slice(0, 8),
    }));

    if (filteredSessions.length > PAGE_SIZE) {
      clack.log.info(
        chalk.gray(
          `Showing first ${PAGE_SIZE} of ${filteredSessions.length} sessions. Use --source to narrow results.`,
        ),
      );
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
    const targetTool = await selectTargetTool(session);
    if (!targetTool) return;

    const forwarding: HandoffForwardingOptions | undefined =
      targetTool !== session.source ? { tailArgs: options.forwardArgs } : undefined;

    if (forwarding) {
      const resolved = resolveCrossToolForwarding(targetTool, forwarding);
      await showForwardingWarnings(resolved.warnings, context);
    }

    // Step 4: Show what will happen and resume
    console.log();
    clack.log.info(`Working directory: ${chalk.cyan(session.cwd)}`);
    clack.log.info(`Command: ${chalk.cyan(getResumeCommand(session, targetTool, forwarding))}`);
    console.log();

    clack.log.step(`Handing off to ${targetTool}...`);
    clack.outro(`Launching ${targetTool}`);

    // Change to session's working directory and resume
    if (session.cwd) process.chdir(session.cwd);
    await resume(session, targetTool, 'inline', forwarding);
  } catch (error) {
    if (clack.isCancel(error)) {
      clack.cancel('Cancelled');
      return;
    }
    clack.log.error(`${(error as Error).message}`);
    process.exitCode = 1;
  }
}

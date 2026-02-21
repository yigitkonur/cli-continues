import * as clack from '@clack/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { formatSessionColored } from '../display/format.js';
import type { SessionSource } from '../types/index.js';
import type { HandoffForwardingOptions } from '../utils/forward-flags.js';
import { findSession, formatSession, getAllSessions } from '../utils/index.js';
import { getResumeCommand, resolveCrossToolForwarding, resume } from '../utils/resume.js';
import { selectTargetTool, showForwardingWarnings } from './_shared.js';

/**
 * Resume a specific session by ID
 */
export async function resumeCommand(
  sessionId: string,
  options: { in?: string; reference?: boolean; noTui?: boolean },
  context: { isTTY: boolean },
  forwarding?: HandoffForwardingOptions,
): Promise<void> {
  try {
    const spinner = context.isTTY && !options.noTui ? ora('Finding session...').start() : null;
    const session = await findSession(sessionId);
    if (spinner) spinner.stop();

    if (!session) {
      // Try to find similar sessions
      const allSessions = await getAllSessions();
      const similar = allSessions
        .filter(
          (s) =>
            s.id.toLowerCase().includes(sessionId.toLowerCase()) ||
            s.summary?.toLowerCase().includes(sessionId.toLowerCase()),
        )
        .slice(0, 3);

      console.error(chalk.red(`Session not found: ${sessionId}`));

      if (similar.length > 0) {
        console.log(chalk.yellow('\nDid you mean one of these?'));
        for (const s of similar) {
          console.log(`  ${formatSessionColored(s)}`);
        }
      }

      process.exitCode = 1;
      return;
    }

    const target = options.in as SessionSource | undefined;
    const mode = options.reference ? ('reference' as const) : ('inline' as const);

    const forwardingFor = (candidateTarget: SessionSource | undefined): HandoffForwardingOptions | undefined => {
      if (!candidateTarget || candidateTarget === session.source) return undefined;
      return forwarding;
    };

    // In non-interactive mode, just resume directly
    if (!context.isTTY || options.noTui) {
      const effectiveForwarding = forwardingFor(target);
      if (target && effectiveForwarding) {
        const resolved = resolveCrossToolForwarding(target, effectiveForwarding);
        await showForwardingWarnings(resolved.warnings, context);
      }

      console.log(chalk.gray('Session: ') + formatSession(session));
      console.log(chalk.gray('Command: ') + chalk.cyan(getResumeCommand(session, target, effectiveForwarding)));
      console.log();

      if (session.cwd) process.chdir(session.cwd);
      await resume(session, target, mode, effectiveForwarding);
      return;
    }

    // Interactive mode - show details and prompt for target if not specified
    if (context.isTTY && !target) {
      clack.intro(chalk.bold('Resume session'));

      console.log(formatSessionColored(session));
      console.log();

      const selectedTarget = await selectTargetTool(session);
      if (!selectedTarget) return;

      const effectiveForwarding = forwardingFor(selectedTarget);
      if (effectiveForwarding) {
        const resolved = resolveCrossToolForwarding(selectedTarget, effectiveForwarding);
        await showForwardingWarnings(resolved.warnings, context);
      }

      clack.log.step(`Handing off to ${selectedTarget}...`);
      clack.outro(`Launching ${selectedTarget}`);

      if (session.cwd) process.chdir(session.cwd);
      await resume(session, selectedTarget, mode, effectiveForwarding);
    } else {
      // Target specified, just resume
      const effectiveForwarding = forwardingFor(target);
      if (target && effectiveForwarding) {
        const resolved = resolveCrossToolForwarding(target, effectiveForwarding);
        await showForwardingWarnings(resolved.warnings, context);
      }

      console.log(chalk.gray('Session: ') + formatSession(session));
      console.log(chalk.gray('Command: ') + chalk.cyan(getResumeCommand(session, target, effectiveForwarding)));
      console.log();

      if (session.cwd) process.chdir(session.cwd);
      await resume(session, target, mode, effectiveForwarding);
    }
  } catch (error) {
    if (clack.isCancel(error)) {
      clack.cancel('Cancelled');
      return;
    }
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exitCode = 1;
  }
}

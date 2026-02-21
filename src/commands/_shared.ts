import * as clack from '@clack/prompts';
import chalk from 'chalk';
import type { Command } from 'commander';
import { sourceColors } from '../display/format.js';
import { ALL_TOOLS } from '../parsers/registry.js';
import type { SessionSource, UnifiedSession } from '../types/index.js';
import { getAvailableTools } from '../utils/resume.js';

/**
 * Show interactive tool-selection TUI and return the chosen target tool.
 * Returns null if user cancels or no tools are available.
 *
 * Shared by pick, resume, and quick-resume commands to avoid 3x duplication.
 */
export async function selectTargetTool(
  session: UnifiedSession,
  options?: { excludeSource?: boolean },
): Promise<SessionSource | null> {
  const availableTools = await getAvailableTools();
  const exclude = options?.excludeSource ?? true;

  const targetOptions = availableTools
    .filter((t) => !exclude || t !== session.source)
    .map((t) => ({
      value: t,
      label:
        t === session.source
          ? `${sourceColors[t](t.charAt(0).toUpperCase() + t.slice(1))} (native resume)`
          : `${sourceColors[t](t.charAt(0).toUpperCase() + t.slice(1))}`,
    }));

  if (targetOptions.length === 0) {
    const missing = ALL_TOOLS.filter((t) => !availableTools.includes(t)).map(
      (t) => t.charAt(0).toUpperCase() + t.slice(1),
    );
    clack.log.warn(
      `Only ${sourceColors[session.source](session.source)} is installed. ` +
        `Install at least one more (${missing.join(', ')}) to enable cross-tool handoff.`,
    );
    return null;
  }

  const targetTool = (await clack.select({
    message: `Continue ${sourceColors[session.source](session.source)} session in:`,
    options: targetOptions,
    ...(exclude ? {} : { initialValue: session.source }),
  })) as SessionSource;

  if (clack.isCancel(targetTool)) {
    clack.cancel('Cancelled');
    return null;
  }

  return targetTool;
}

/**
 * Check if only the native tool is available and auto-resume if so.
 * Returns true if it handled the auto-resume (caller should return).
 */
export async function checkSingleToolAutoResume(
  session: UnifiedSession,
  nativeResumeFn: (s: UnifiedSession) => Promise<void>,
): Promise<boolean> {
  const availableTools = await getAvailableTools();
  if (availableTools.length === 1 && availableTools[0] === session.source) {
    clack.log.step(`Resuming natively in ${sourceColors[session.source](session.source)}...`);
    clack.outro(`Launching ${session.source}`);
    if (session.cwd) process.chdir(session.cwd);
    await nativeResumeFn(session);
    return true;
  }
  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Warn user about precedence remapping and give a brief countdown in TTY mode.
 */
export async function showForwardingWarnings(
  warnings: string[],
  context: { isTTY: boolean },
  seconds = 5,
): Promise<void> {
  if (warnings.length === 0) return;

  for (const warning of warnings) {
    clack.log.warn(warning);
  }

  if (!context.isTTY || seconds <= 0) return;

  for (let remaining = seconds; remaining >= 1; remaining -= 1) {
    process.stdout.write(chalk.yellow(`\rContinuing in ${remaining}s... `));
    await wait(1000);
  }

  process.stdout.write('\r');
  process.stdout.write(' '.repeat(24));
  process.stdout.write('\r');
}

/**
 * Extract extra CLI args from commander command object.
 * Used for forwarding unknown options to target CLI tools.
 */
export function getExtraCommandArgs(command: Command, processedArgCount: number): string[] {
  return command.args.slice(processedArgCount);
}

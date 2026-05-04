import chalk from 'chalk';
import { formatSessionColored } from '../display/format.js';
import { isSessionSource, type SessionSource, TOOL_NAMES } from '../types/index.js';
import { getSessionsBySource } from '../utils/index.js';
import { nativeResume, resume } from '../utils/resume.js';

export interface QuickResumeOptions {
  /** Hand off to a different tool instead of native-resuming */
  in?: string;
  preset?: string;
  configPath?: string;
  chain?: boolean;
}

/**
 * Resume Nth session from a specific source tool.
 * Pass `options.in` to hand off to a different tool (e.g. `continues claude --in codex`).
 */
export async function resumeBySource(source: SessionSource, n: number, options?: QuickResumeOptions): Promise<void> {
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

    if (session.cwd) process.chdir(session.cwd);

    const targetTool = options?.in;
    if (targetTool) {
      if (!isSessionSource(targetTool)) {
        console.error(
          chalk.red('Error:'),
          `Unknown target tool: ${targetTool}. Expected one of: ${TOOL_NAMES.join(', ')}.`,
        );
        process.exitCode = 1;
        return;
      }
      await resume(session, targetTool, 'inline', undefined, {
        preset: options?.preset,
        configPath: options?.configPath,
        chain: options?.chain,
      });
    } else {
      await nativeResume(session);
    }
  } catch (error) {
    console.error(chalk.red('Error:'), (error as Error).message);
    process.exitCode = 1;
  }
}

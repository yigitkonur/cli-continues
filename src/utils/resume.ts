import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../logger.js';
import { ALL_TOOLS, adapters } from '../parsers/registry.js';
import type { SessionContext, SessionSource, UnifiedSession } from '../types/index.js';
import {
  type ForwardResolution,
  formatForwardArgs,
  type HandoffForwardingOptions,
  resolveTargetForwarding,
} from './forward-flags.js';
import { extractContext, saveContext } from './index.js';
import { getSourceLabels, safePath } from './markdown.js';
import { IS_WINDOWS, WHICH_CMD } from './platform.js';

/**
 * Resolve mapped + passthrough forward args for cross-tool launches.
 */
export function resolveCrossToolForwarding(
  target: SessionSource,
  options?: HandoffForwardingOptions,
): ForwardResolution {
  const adapter = adapters[target];
  return resolveTargetForwarding(target, adapter?.mapHandoffFlags, options);
}

function hasConfigOverride(args: string[], key: string): boolean {
  const keyPrefix = `${key}=`;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if ((token === '-c' || token === '--config') && index + 1 < args.length) {
      const value = args[index + 1]?.trim();
      if (value?.startsWith(keyPrefix)) return true;
      index += 1;
      continue;
    }

    if (token.startsWith('-c=')) {
      if (token.slice(3).trim().startsWith(keyPrefix)) return true;
    }

    if (token.startsWith('--config=')) {
      if (token.slice('--config='.length).trim().startsWith(keyPrefix)) return true;
    }
  }

  return false;
}

export function getDefaultHandoffInitArgs(target: SessionSource, forwardedArgs: string[] = []): string[] {
  if (target !== 'codex') return [];

  const defaults: string[] = [];

  if (!hasConfigOverride(forwardedArgs, 'model_reasoning_effort')) {
    defaults.push('-c', 'model_reasoning_effort="high"');
  }

  if (!hasConfigOverride(forwardedArgs, 'model_reasoning_summary')) {
    defaults.push('-c', 'model_reasoning_summary="detailed"');
  }

  if (!hasConfigOverride(forwardedArgs, 'model_supports_reasoning_summaries')) {
    defaults.push('-c', 'model_supports_reasoning_summaries=true');
  }

  return defaults;
}

/**
 * Resume a session using native CLI commands
 */
export async function nativeResume(session: UnifiedSession): Promise<void> {
  const cwd = session.cwd || process.cwd();
  const adapter = adapters[session.source];
  if (!adapter) throw new Error(`Unknown session source: ${session.source}`);
  await runCommand(adapter.binaryName, adapter.nativeResumeArgs(session), cwd);
}

/**
 * Resume a session in a different tool (cross-tool)
 */
export async function crossToolResume(
  session: UnifiedSession,
  target: SessionSource,
  mode: 'inline' | 'reference' = 'inline',
  forwarding?: HandoffForwardingOptions,
): Promise<void> {
  const context = await extractContext(session);
  const cwd = session.cwd || process.cwd();

  // Always save handoff file to project directory (for sandboxed tools like Gemini)
  const localPath = path.join(cwd, '.continues-handoff.md');
  let handoffWritten = false;
  try {
    fs.writeFileSync(localPath, context.markdown);
    handoffWritten = true;
  } catch (err) {
    logger.debug('resume: failed to write handoff file', localPath, err);
  }

  // Also save to global directory as backup
  saveContext(context);

  // On Windows the prompt references .continues-handoff.md — the write must succeed
  if (IS_WINDOWS && !handoffWritten) {
    throw new Error(
      `Failed to write handoff file to ${localPath}. Cross-tool resume on Windows requires this file. Check directory permissions.`,
    );
  }

  // Build prompt based on mode
  const prompt = IS_WINDOWS
    ? buildWindowsSafePrompt(session)
    : mode === 'inline'
      ? buildInlinePrompt(context, session)
      : buildReferencePrompt(session);

  const adapter = adapters[target];
  if (!adapter) throw new Error(`Unknown target: ${target}`);

  const resolved = resolveCrossToolForwarding(target, forwarding);
  const defaultInitArgs = getDefaultHandoffInitArgs(target, resolved.extraArgs);
  await runCommand(
    adapter.binaryName,
    [...defaultInitArgs, ...resolved.extraArgs, ...adapter.crossToolArgs(prompt, cwd)],
    cwd,
  );
}

/**
 * Build an inline prompt that embeds the full session context directly.
 * The LLM gets everything upfront — no file reading needed.
 */
function buildInlinePrompt(context: SessionContext, session: UnifiedSession): string {
  const sourceLabel = getSourceLabels()[session.source] || session.source;

  // Simple intro — the handoff markdown already has the full table, conversation, and closing directive
  const sessionFileRef = session.originalPath ? ` (original session: \`${safePath(session.originalPath)}\`)` : '';
  const intro = `I'm continuing a coding session from **${sourceLabel}**${sessionFileRef}. Here's the full context:\n\n---\n\n`;

  return intro + context.markdown;
}

/**
 * Build a compact reference prompt that points to the handoff file.
 * Used when --reference flag is passed (for very large sessions).
 */
function buildReferencePrompt(session: UnifiedSession): string {
  const sourceLabel = getSourceLabels()[session.source] || session.source;

  return [
    `# 🔄 Session Handoff`,
    ``,
    `Picking up a coding session from **${sourceLabel}**. The full context is in \`.continues-handoff.md\`.`,
    ``,
    `| Detail | Value |`,
    `|--------|-------|`,
    `| Previous tool | ${sourceLabel} |`,
    `| Working directory | \`${session.cwd}\` |`,
    session.originalPath ? `| Original session file | \`${safePath(session.originalPath)}\` |` : '',
    `| Context file | \`.continues-handoff.md\` |`,
    session.summary ? `| Last task | ${session.summary.slice(0, 80)} |` : '',
    ``,
    `Read \`.continues-handoff.md\` first, then continue the work.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build a single-line, cmd.exe-safe prompt for Windows cross-tool handoff.
 *
 * On Windows, `spawn()` with `shell: true` passes args through `cmd.exe`,
 * which treats embedded newlines as command separators and splits on shell
 * metacharacters (`|`, `&`, `>`, `<`, `^`, `%`, `!`, backticks, `"`).
 * Additionally, `cmd.exe` has an 8191-character command-line limit.
 *
 * Since `.continues-handoff.md` is already written to the project directory,
 * this prompt simply instructs the target tool to read that file.
 */
export function buildWindowsSafePrompt(session: UnifiedSession): string {
  return `Continuing a coding session from ${session.source}. Read the file .continues-handoff.md in the current directory for full context and continue where it left off.`;
}

/**
 * Resume a session - automatically chooses native or cross-tool
 */
export async function resume(
  session: UnifiedSession,
  target?: SessionSource,
  mode: 'inline' | 'reference' = 'inline',
  forwarding?: HandoffForwardingOptions,
): Promise<void> {
  const actualTarget = target || session.source;

  if (actualTarget === session.source) {
    // Same tool - use native resume
    await nativeResume(session);
  } else {
    // Different tool - use cross-tool injection
    await crossToolResume(session, actualTarget, mode, forwarding);
  }
}

/**
 * Run a command with proper TTY handling
 */
function runCommand(command: string, args: string[], cwd: string, stdinData?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdio: import('node:child_process').StdioOptions = stdinData ? ['pipe', 'inherit', 'inherit'] : 'inherit';

    // On Windows, invoke cmd.exe explicitly to handle .cmd/.bat shims.
    // Args stay in the array — no shell:true (avoids DEP0190), no string
    // concatenation (avoids command-injection risk).
    const child = IS_WINDOWS
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', command, ...args], { cwd, stdio })
      : spawn(command, args, { cwd, stdio });

    if (stdinData && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Check if a CLI tool is available by binary name
 */
async function isBinaryAvailable(binaryName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(WHICH_CMD, [binaryName], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Get available tools
 */
export async function getAvailableTools(): Promise<SessionSource[]> {
  const checks = await Promise.allSettled(
    ALL_TOOLS.map(async (name) => ({
      name,
      ok: await isBinaryAvailable(adapters[name].binaryName),
    })),
  );

  return checks
    .filter(
      (r): r is PromiseFulfilledResult<{ name: SessionSource; ok: boolean }> => r.status === 'fulfilled' && r.value.ok,
    )
    .map((r) => r.value.name);
}

/**
 * Get resume command for display purposes
 */
export function getResumeCommand(
  session: UnifiedSession,
  target?: SessionSource,
  forwarding?: HandoffForwardingOptions,
): string {
  const actualTarget = target || session.source;

  if (actualTarget === session.source) {
    return adapters[session.source].resumeCommandDisplay(session);
  }

  const resolved = resolveCrossToolForwarding(actualTarget, forwarding);
  const defaultInitArgs = getDefaultHandoffInitArgs(actualTarget, resolved.extraArgs);
  const suffixArgs = [...defaultInitArgs, ...resolved.extraArgs];
  const suffix = suffixArgs.length > 0 ? ` ${formatForwardArgs(suffixArgs)}` : '';
  return `continues resume ${session.id} --in ${actualTarget}${suffix}`;
}

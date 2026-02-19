import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedSession, SessionSource, SessionContext } from '../types/index.js';
import { extractContext, saveContext } from './index.js';
import { SOURCE_LABELS } from './markdown.js';

/**
 * Resume a session using native CLI commands
 */
export async function nativeResume(session: UnifiedSession): Promise<void> {
  const cwd = session.cwd;

  switch (session.source) {
    case 'codex':
      await runCommand('codex', ['-c', `experimental_resume=${session.originalPath}`], cwd);
      break;

    case 'claude':
      await runCommand('claude', ['--resume', session.id], cwd);
      break;

    case 'copilot':
      await runCommand('copilot', ['--resume', session.id], cwd);
      break;

    case 'gemini':
      // Gemini uses --continue to resume the last session in cwd
      await runCommand('gemini', ['--continue'], cwd);
      break;

    case 'opencode':
      // OpenCode uses --session to resume a specific session
      await runCommand('opencode', ['--session', session.id], cwd);
      break;

    case 'droid':
      // Droid uses -s to resume a specific session
      await runCommand('droid', ['-s', session.id], cwd);
      break;

    case 'cursor':
      // Cursor doesn't have native session resume via CLI; open the project
      await runCommand('cursor', [cwd], cwd);
      break;

    default:
      throw new Error(`Unknown session source: ${session.source}`);
  }
}

/**
 * Resume a session in a different tool (cross-tool)
 */
export async function crossToolResume(
  session: UnifiedSession,
  target: SessionSource,
  mode: 'inline' | 'reference' = 'inline',
): Promise<void> {
  const context = await extractContext(session);
  const cwd = session.cwd;

  // Always save handoff file to project directory (for sandboxed tools like Gemini)
  const localPath = path.join(cwd, '.continues-handoff.md');
  try { fs.writeFileSync(localPath, context.markdown); } catch { /* non-critical */ }

  // Also save to global directory as backup
  saveContext(context);

  // Build prompt based on mode
  const prompt = mode === 'inline'
    ? buildInlinePrompt(context, session)
    : buildReferencePrompt(session, localPath);

  // Each tool has different CLI syntax for accepting a prompt
  switch (target) {
    case 'codex':
      await runCommand('codex', [prompt], cwd);
      break;

    case 'claude':
      await runCommand('claude', [prompt], cwd);
      break;

    case 'copilot':
      await runCommand('copilot', ['-i', prompt], cwd);
      break;

    case 'gemini':
      await runCommand('gemini', [prompt], cwd);
      break;

    case 'opencode':
      await runCommand('opencode', ['--prompt', prompt], cwd);
      break;

    case 'droid':
      await runCommand('droid', ['exec', prompt], cwd);
      break;

    case 'cursor':
      // Cursor CLI doesn't accept inline prompts; open the project with handoff file
      await runCommand('cursor', [cwd], cwd);
      break;

    default:
      throw new Error(`Unknown target: ${target}`);
  }
}

/**
 * Build an inline prompt that embeds the full session context directly.
 * The LLM gets everything upfront — no file reading needed.
 */
function buildInlinePrompt(context: SessionContext, session: UnifiedSession): string {
  const sourceLabel = SOURCE_LABELS[session.source] || session.source;

  // Simple intro — the handoff markdown already has the full table, conversation, and closing directive
  const intro = `I'm continuing a coding session from **${sourceLabel}**. Here's the full context:\n\n---\n\n`;

  return intro + context.markdown;
}

/**
 * Build a compact reference prompt that points to the handoff file.
 * Used when --reference flag is passed (for very large sessions).
 */
function buildReferencePrompt(session: UnifiedSession, filePath: string): string {
  const sourceLabel = SOURCE_LABELS[session.source] || session.source;

  return [
    `# 🔄 Session Handoff`,
    ``,
    `Picking up a coding session from **${sourceLabel}**. The full context is in \`.continues-handoff.md\`.`,
    ``,
    `| Detail | Value |`,
    `|--------|-------|`,
    `| Previous tool | ${sourceLabel} |`,
    `| Working directory | \`${session.cwd}\` |`,
    `| Context file | \`.continues-handoff.md\` |`,
    session.summary ? `| Last task | ${session.summary.slice(0, 80)} |` : '',
    ``,
    `Read \`.continues-handoff.md\` first, then continue the work.`,
  ].filter(Boolean).join('\n');
}

/**
 * Resume a session - automatically chooses native or cross-tool
 */
export async function resume(session: UnifiedSession, target?: SessionSource, mode: 'inline' | 'reference' = 'inline'): Promise<void> {
  const actualTarget = target || session.source;

  if (actualTarget === session.source) {
    // Same tool - use native resume
    await nativeResume(session);
  } else {
    // Different tool - use cross-tool injection
    await crossToolResume(session, actualTarget, mode);
  }
}

/**
 * Run a command with proper TTY handling
 */
function runCommand(command: string, args: string[], cwd: string, stdinData?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: stdinData ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      shell: false,
    });

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
 * Check if a CLI tool is available
 */
export async function isToolAvailable(tool: SessionSource): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', [tool], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Get available tools
 */
export async function getAvailableTools(): Promise<SessionSource[]> {
  const tools: SessionSource[] = [];
  
  const [hasCodex, hasClaude, hasCopilot, hasGemini, hasOpencode, hasDroid, hasCursor] = await Promise.all([
    isToolAvailable('codex'),
    isToolAvailable('claude'),
    isToolAvailable('copilot'),
    isToolAvailable('gemini'),
    isToolAvailable('opencode'),
    isToolAvailable('droid'),
    isToolAvailable('cursor'),
  ]);

  if (hasCodex) tools.push('codex');
  if (hasClaude) tools.push('claude');
  if (hasCopilot) tools.push('copilot');
  if (hasGemini) tools.push('gemini');
  if (hasOpencode) tools.push('opencode');
  if (hasDroid) tools.push('droid');
  if (hasCursor) tools.push('cursor');

  return tools;
}

/**
 * Get resume command for display purposes
 */
export function getResumeCommand(session: UnifiedSession, target?: SessionSource): string {
  const actualTarget = target || session.source;

  if (actualTarget === session.source) {
    switch (session.source) {
      case 'codex':
        return `codex -c experimental_resume="${session.originalPath}"`;
      case 'claude':
        return `claude --resume ${session.id}`;
      case 'copilot':
        return `copilot --resume ${session.id}`;
      case 'gemini':
        return `gemini --continue`;
      case 'opencode':
        return `opencode --session ${session.id}`;
      case 'droid':
        return `droid -s ${session.id}`;
      case 'cursor':
        return `cursor ${session.cwd}`;
    }
  }

  // Cross-tool
  return `continues resume ${session.id} --in ${actualTarget}`;
}

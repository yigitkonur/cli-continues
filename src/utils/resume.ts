import { spawn } from 'child_process';
import * as path from 'path';
import type { UnifiedSession, SessionSource, SessionContext } from '../types/index.js';
import { extractContext, saveContext } from './index.js';

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

    default:
      throw new Error(`Unknown session source: ${session.source}`);
  }
}

/**
 * Resume a session in a different tool (cross-tool)
 */
export async function crossToolResume(session: UnifiedSession, target: SessionSource): Promise<void> {
  // Extract context from original session
  const context = await extractContext(session);
  
  // Save context to disk
  const contextPath = saveContext(context);
  
  // Read the markdown content
  const prompt = context.markdown;
  const cwd = session.cwd;

  // Launch target tool with injected context
  switch (target) {
    case 'codex':
      // Codex accepts prompt as argument
      await runCommand('codex', [prompt], cwd);
      break;

    case 'claude':
      // Claude can use -i for interactive with initial prompt
      await runCommand('claude', [], cwd, prompt);
      break;

    case 'copilot':
      // Copilot can use -i for interactive with initial prompt
      await runCommand('copilot', ['-i', prompt], cwd);
      break;

    case 'gemini':
      // Gemini accepts prompt as argument
      await runCommand('gemini', [prompt], cwd);
      break;

    case 'opencode':
      // OpenCode accepts prompt as argument
      await runCommand('opencode', [prompt], cwd);
      break;

    default:
      throw new Error(`Unknown target: ${target}`);
  }
}

/**
 * Resume a session - automatically chooses native or cross-tool
 */
export async function resume(session: UnifiedSession, target?: SessionSource): Promise<void> {
  const actualTarget = target || session.source;

  if (actualTarget === session.source) {
    // Same tool - use native resume
    await nativeResume(session);
  } else {
    // Different tool - use cross-tool injection
    await crossToolResume(session, actualTarget);
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
  
  const [hasCodex, hasClaude, hasCopilot, hasGemini, hasOpencode] = await Promise.all([
    isToolAvailable('codex'),
    isToolAvailable('claude'),
    isToolAvailable('copilot'),
    isToolAvailable('gemini'),
    isToolAvailable('opencode'),
  ]);

  if (hasCodex) tools.push('codex');
  if (hasClaude) tools.push('claude');
  if (hasCopilot) tools.push('copilot');
  if (hasGemini) tools.push('gemini');
  if (hasOpencode) tools.push('opencode');

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
    }
  }

  // Cross-tool
  return `sessionr resume ${session.id} --target ${actualTarget}`;
}

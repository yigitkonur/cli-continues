import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedSession, SessionSource, SessionContext } from '../types/index.js';
import { extractContext, saveContext } from './index.js';
import { SOURCE_LABELS } from './markdown.js';

/**
 * Per-tool autonomy/safety flags that can be forwarded to target CLI tools.
 * Only flags supported at launch time by each tool are included.
 * Copilot and OpenCode are intentionally omitted — they have no startup autonomy flags.
 */
export interface ToolFlags {
  // ── Codex ──────────────────────────────────────────────────────────────────
  /** codex --full-auto: workspace-write sandbox + on-request approvals */
  fullAuto?: boolean;
  /** codex --dangerously-bypass-approvals-and-sandbox: no sandbox, no approvals */
  yolo?: boolean;
  /** codex --sandbox <mode>: 'read-only' | 'workspace-write' | 'danger-full-access' */
  sandbox?: string;
  /** codex --ask-for-approval <policy>: 'on-request' | 'untrusted' | 'never' */
  askForApproval?: string;

  // ── Claude ─────────────────────────────────────────────────────────────────
  /** claude --dangerously-skip-permissions: skip all permission prompts */
  dangerouslySkipPermissions?: boolean;
  /** claude --permission-mode <mode>: e.g. 'plan' */
  permissionMode?: string;

  // ── Gemini ─────────────────────────────────────────────────────────────────
  /** gemini --approval-mode <mode>: 'default' | 'auto_edit' | 'yolo' */
  approvalMode?: string;
  /** gemini --sandbox: run in sandboxed environment */
  geminiSandbox?: boolean;

  // ── Droid ──────────────────────────────────────────────────────────────────
  /** droid --auto <level>: 'low' | 'medium' | 'high' */
  auto?: string;
  /** droid --skip-permissions-unsafe: skip all permission prompts (dangerous) */
  skipPermissionsUnsafe?: boolean;

  // ── Shared ─────────────────────────────────────────────────────────────────
  /** --model <name>: forwarded to all tools that support it */
  model?: string;
}

/**
 * Build the CLI argument array for a given tool from a ToolFlags object.
 * Returns only the flags that are relevant to and supported by the target tool.
 */
export function buildToolArgs(tool: SessionSource, flags: ToolFlags): string[] {
  const args: string[] = [];

  switch (tool) {
    case 'codex':
      if (flags.fullAuto) args.push('--full-auto');
      // --yolo maps to codex's verbose flag name
      if (flags.yolo) args.push('--dangerously-bypass-approvals-and-sandbox');
      if (flags.sandbox) args.push('--sandbox', flags.sandbox);
      if (flags.askForApproval) args.push('--ask-for-approval', flags.askForApproval);
      if (flags.model) args.push('--model', flags.model);
      break;

    case 'claude':
      if (flags.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
      if (flags.permissionMode) args.push('--permission-mode', flags.permissionMode);
      if (flags.model) args.push('--model', flags.model);
      break;

    case 'gemini':
      // --yolo on continues maps to gemini's --approval-mode yolo
      if (flags.yolo) args.push('--approval-mode', 'yolo');
      else if (flags.approvalMode) args.push('--approval-mode', flags.approvalMode);
      if (flags.geminiSandbox) args.push('--sandbox');
      if (flags.model) args.push('--model', flags.model);
      break;

    case 'droid':
      if (flags.auto) args.push('--auto', flags.auto);
      if (flags.skipPermissionsUnsafe) args.push('--skip-permissions-unsafe');
      if (flags.model) args.push('--model', flags.model);
      break;

    // copilot and opencode have no startup autonomy/safety flags — pass nothing
    case 'copilot':
    case 'opencode':
      break;
  }

  return args;
}

/**
 * Resume a session using native CLI commands
 */
export async function nativeResume(session: UnifiedSession, flags?: ToolFlags): Promise<void> {
  const cwd = session.cwd;
  const extraArgs = flags ? buildToolArgs(session.source, flags) : [];

  switch (session.source) {
    case 'codex':
      await runCommand('codex', [...extraArgs, '-c', `experimental_resume=${session.originalPath}`], cwd);
      break;

    case 'claude':
      await runCommand('claude', [...extraArgs, '--resume', session.id], cwd);
      break;

    case 'copilot':
      await runCommand('copilot', ['--resume', session.id], cwd);
      break;

    case 'gemini':
      // Gemini uses --continue to resume the last session in cwd
      await runCommand('gemini', [...extraArgs, '--continue'], cwd);
      break;

    case 'opencode':
      // OpenCode uses --session to resume a specific session
      await runCommand('opencode', ['--session', session.id], cwd);
      break;

    case 'droid':
      // Droid uses -s to resume a specific session
      await runCommand('droid', [...extraArgs, '-s', session.id], cwd);
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
  flags?: ToolFlags,
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

  const extraArgs = flags ? buildToolArgs(target, flags) : [];

  // Each tool has different CLI syntax for accepting a prompt
  switch (target) {
    case 'codex':
      await runCommand('codex', [...extraArgs, prompt], cwd);
      break;

    case 'claude':
      await runCommand('claude', [...extraArgs, prompt], cwd);
      break;

    case 'copilot':
      await runCommand('copilot', ['-i', prompt], cwd);
      break;

    case 'gemini':
      await runCommand('gemini', [...extraArgs, prompt], cwd);
      break;

    case 'opencode':
      await runCommand('opencode', ['--prompt', prompt], cwd);
      break;

    case 'droid':
      await runCommand('droid', [...extraArgs, 'exec', prompt], cwd);
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
export async function resume(
  session: UnifiedSession,
  target?: SessionSource,
  mode: 'inline' | 'reference' = 'inline',
  flags?: ToolFlags,
): Promise<void> {
  const actualTarget = target || session.source;

  if (actualTarget === session.source) {
    await nativeResume(session, flags);
  } else {
    await crossToolResume(session, actualTarget, mode, flags);
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

export function getResumeCommand(session: UnifiedSession, target?: SessionSource, flags?: ToolFlags): string {
  const actualTarget = target || session.source;
  const extraArgs = flags ? buildToolArgs(actualTarget, flags) : [];
  const flagSuffix = extraArgs.length > 0 ? ` ${extraArgs.join(' ')}` : '';

  if (actualTarget === session.source) {
    switch (session.source) {
      case 'codex':
        return `codex${flagSuffix} -c experimental_resume="${session.originalPath}"`;
      case 'claude':
        return `claude${flagSuffix} --resume ${session.id}`;
      case 'copilot':
        return `copilot --resume ${session.id}`;
      case 'gemini':
        return `gemini${flagSuffix} --continue`;
      case 'opencode':
        return `opencode --session ${session.id}`;
      case 'droid':
        return `droid${flagSuffix} -s ${session.id}`;
        return `droid -s ${session.id}`;
      case 'cursor':
        return `cursor ${session.cwd}`;
    }
  }

  const continuesFlagSuffix = flags ? ` ${buildContinuesFlagString(flags)}`.trimEnd() : '';
  return `continues resume ${session.id} --in ${actualTarget}${continuesFlagSuffix}`;
}

function buildContinuesFlagString(flags: ToolFlags): string {
  const parts: string[] = [];
  if (flags.fullAuto) parts.push('--full-auto');
  if (flags.yolo) parts.push('--yolo');
  if (flags.sandbox) parts.push(`--sandbox ${flags.sandbox}`);
  if (flags.askForApproval) parts.push(`--ask-for-approval ${flags.askForApproval}`);
  if (flags.dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions');
  if (flags.permissionMode) parts.push(`--permission-mode ${flags.permissionMode}`);
  if (flags.approvalMode) parts.push(`--approval-mode ${flags.approvalMode}`);
  if (flags.geminiSandbox) parts.push('--gemini-sandbox');
  if (flags.auto) parts.push(`--auto ${flags.auto}`);
  if (flags.skipPermissionsUnsafe) parts.push('--skip-permissions-unsafe');
  if (flags.model) parts.push(`--model ${flags.model}`);
  return parts.join(' ');
}

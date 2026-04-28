import chalk from 'chalk';
import type { VerbosityConfig } from '../config/index.js';
import type { SessionContext, SessionParseOptions, SessionSource, UnifiedSession } from '../types/index.js';
import { TOOL_NAMES } from '../types/tool-names.js';
import {
  type FlagOccurrence,
  type ForwardFlagMapContext,
  type ForwardFlagMapper,
  type ForwardMapResult,
  normalizeAgentSandbox,
} from '../utils/forward-flags.js';
import { extractAmpContext, parseAmpSessions } from './amp.js';
import { extractAntigravityContext, parseAntigravitySessions } from './antigravity.js';
import { extractClaudeContext, parseClaudeSessions } from './claude.js';
import {
  extractClineContext,
  extractKiloCodeContext,
  extractRooCodeContext,
  parseClineSessions,
  parseKiloCodeSessions,
  parseRooCodeSessions,
} from './cline.js';
import { extractCodexContext, parseCodexSessions } from './codex.js';
import { extractCopilotContext, parseCopilotSessions } from './copilot.js';
import { extractCrushContext, parseCrushSessions } from './crush.js';
import { extractCursorContext, parseCursorSessions } from './cursor.js';
import { extractDroidContext, parseDroidSessions } from './droid.js';
import { extractGeminiContext, parseGeminiSessions } from './gemini.js';
import { extractKimiContext, parseKimiSessions } from './kimi.js';
import { extractKiroContext, parseKiroSessions } from './kiro.js';
import { extractOpenCodeContext, parseOpenCodeSessions } from './opencode.js';
import { extractQwenCodeContext, parseQwenCodeSessions } from './qwen-code.js';

/**
 * Adapter interface — single contract for all supported CLI tools.
 * To add a new tool, create its parser and add an entry here.
 */
export interface ToolAdapter {
  /** Unique identifier — must match a member of the SessionSource union */
  name: SessionSource;
  /** Human-readable label (e.g. "Claude Code") */
  label: string;
  /** Chalk color function for TUI display */
  color: (s: string) => string;
  /** Storage directory path (for help text) */
  storagePath: string;
  /** Environment variable that overrides the default storage path (if any) */
  envVar?: string;
  /**
   * Additional environment variables that influence the parser's storage
   * resolution beyond `envVar`. Used by the index cache fingerprint so changes
   * to any of these invalidate the cache. Example: Antigravity falls back to
   * `GEMINI_CLI_HOME` when `ANTIGRAVITY_HOME` is unset.
   */
  extraEnvVars?: string[];
  /** CLI binary name for availability checks and spawning */
  binaryName: string;
  /** Additional binary names to try when the primary name is unavailable */
  binaryFallbacks?: string[];
  /** Discover and index sessions. Parsers may ignore unsupported options. */
  parseSessions: (options?: SessionParseOptions) => Promise<UnifiedSession[]>;
  /** True when parseSessions({ cwd }) can avoid a full global scan. */
  supportsCwdLookup?: boolean;
  /** Extract full context for cross-tool handoff */
  extractContext: (session: UnifiedSession, config?: VerbosityConfig) => Promise<SessionContext>;
  /** CLI args to resume a session natively */
  nativeResumeArgs: (session: UnifiedSession) => string[];
  /** CLI args to start with a handoff prompt */
  crossToolArgs: (prompt: string, cwd: string) => string[];
  /** Display string for the native resume command */
  resumeCommandDisplay: (session: UnifiedSession) => string;
  /** Adapter-level mapping for interactive handoff launch flags */
  mapHandoffFlags?: ForwardFlagMapper;
}

/**
 * Central registry — single source of truth for all supported tools.
 * Insertion order determines display order in the TUI.
 */
const _adapters: Partial<Record<SessionSource, ToolAdapter>> = {};

function register(adapter: ToolAdapter): void {
  _adapters[adapter.name] = adapter;
}

function normalizePlanOccurrences(context: ForwardFlagMapContext): FlagOccurrence[] {
  const fromPlanFlag = context.all('plan');
  const fromMode = context.all('mode').filter((occ) => String(occ.value).toLowerCase() === 'plan');
  const fromApproval = context.all('approvalMode').filter((occ) => String(occ.value).toLowerCase() === 'plan');
  const fromPermission = context.all('permissionMode').filter((occ) => String(occ.value).toLowerCase() === 'plan');
  return [...fromPlanFlag, ...fromMode, ...fromApproval, ...fromPermission];
}

function collectAutoApproveOccurrences(context: ForwardFlagMapContext): FlagOccurrence[] {
  return context.all('yolo', 'force', 'allowAll', 'dangerouslyBypass', 'dangerouslySkipPermissions');
}

function mapCodexFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];
  const warnings: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const fullAutoOccurrences = context.all('fullAuto');
  const sandboxOccurrences = context.all('sandbox');
  const askOccurrences = context.all('askForApproval');

  if (autoOccurrences.length > 0) {
    context.consume(...autoOccurrences, ...fullAutoOccurrences, ...sandboxOccurrences, ...askOccurrences);
    args.push('--dangerously-bypass-approvals-and-sandbox');

    if (fullAutoOccurrences.length > 0 || sandboxOccurrences.length > 0 || askOccurrences.length > 0) {
      warnings.push('Codex precedence: auto-approve flags override --full-auto, --sandbox, and --ask-for-approval.');
    }
  } else if (fullAutoOccurrences.length > 0) {
    context.consume(...fullAutoOccurrences, ...sandboxOccurrences, ...askOccurrences);
    args.push('--full-auto');

    if (sandboxOccurrences.length > 0 || askOccurrences.length > 0) {
      warnings.push('Codex precedence: --full-auto overrides --sandbox and --ask-for-approval.');
    }
  } else {
    const sandbox = context.latestString('sandbox');
    if (sandbox) {
      context.consumeKeys('sandbox');
      args.push('--sandbox', sandbox);
    }

    const askForApproval = context.latestString('askForApproval');
    if (askForApproval) {
      context.consumeKeys('askForApproval');
      args.push('--ask-for-approval', askForApproval);
    }
  }

  const model = context.latestString('model');
  if (model) {
    context.consumeKeys('model');
    args.push('--model', model);
  }

  for (const directory of context.consumeAllCsvStrings('addDir', 'includeDirectories')) {
    args.push('--add-dir', directory);
  }

  const cwd = context.latestString('cd', 'workspace');
  if (cwd) {
    context.consumeKeys('cd', 'workspace');
    args.push('--cd', cwd);
  }

  for (const override of context.consumeAllStrings('config')) {
    args.push('--config', override);
  }

  return { mappedArgs: args, warnings };
}

function mapGeminiFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const explicitApprovalMode = context.latestString('approvalMode');
  const planOccurrences = normalizePlanOccurrences(context);

  if (autoOccurrences.length > 0) {
    context.consume(...autoOccurrences, ...context.all('approvalMode'), ...planOccurrences);
    args.push('--approval-mode', 'yolo');
  } else if (explicitApprovalMode) {
    context.consumeKeys('approvalMode');
    args.push('--approval-mode', explicitApprovalMode);
  } else if (planOccurrences.length > 0) {
    context.consume(...planOccurrences);
    args.push('--approval-mode', 'plan');
  }

  const sandbox = context.latest('sandbox');
  if (sandbox) {
    const normalized = String(sandbox.value).toLowerCase();
    if (sandbox.value === true || ['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) {
      context.consumeKeys('sandbox');
      args.push('--sandbox');
    }
  }

  const model = context.latestString('model');
  if (model) {
    context.consumeKeys('model');
    args.push('--model', model);
  }

  const hasDebug = context.has('debug');
  if (hasDebug) {
    context.consumeKeys('debug');
    args.push('--debug');
  }

  for (const directory of context.consumeAllCsvStrings('includeDirectories', 'addDir')) {
    args.push('--include-directories', directory);
  }

  for (const tool of context.consumeAllCsvStrings('allowedTools', 'allowTool')) {
    args.push('--allowed-tools', tool);
  }

  for (const serverName of context.consumeAllCsvStrings('allowedMcpServerNames')) {
    args.push('--allowed-mcp-server-names', serverName);
  }

  return { mappedArgs: args };
}

function mapClaudeFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];
  const warnings: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const planOccurrences = normalizePlanOccurrences(context);

  if (autoOccurrences.length > 0) {
    context.consume(...autoOccurrences);
    args.push('--dangerously-skip-permissions');

    const permissionOccurrences = context.all('permissionMode');
    if (permissionOccurrences.length > 0 || planOccurrences.length > 0) {
      context.consume(...permissionOccurrences, ...planOccurrences);
      warnings.push('Claude precedence: auto-approve flags override permission-mode planning options.');
    }
  } else {
    const permissionMode = context.latestString('permissionMode');
    if (permissionMode) {
      context.consumeKeys('permissionMode');
      args.push('--permission-mode', permissionMode);
    } else if (planOccurrences.length > 0) {
      context.consume(...planOccurrences);
      args.push('--permission-mode', 'plan');
    }
  }

  const model = context.latestString('model');
  if (model) {
    context.consumeKeys('model');
    args.push('--model', model);
  }

  for (const directory of context.consumeAllCsvStrings('addDir', 'includeDirectories')) {
    args.push('--add-dir', directory);
  }

  for (const tool of context.consumeAllCsvStrings('allowedTools', 'allowTool')) {
    args.push('--allowed-tools', tool);
  }

  for (const tool of context.consumeAllCsvStrings('disallowedTools', 'denyTool')) {
    args.push('--disallowed-tools', tool);
  }

  const agent = context.latestString('agent');
  if (agent) {
    context.consumeKeys('agent');
    args.push('--agent', agent);
  }

  const debugOccurrence = context.latest('debug');
  if (debugOccurrence) {
    context.consumeKeys('debug');
    if (typeof debugOccurrence.value === 'string' && debugOccurrence.value.trim().length > 0) {
      args.push('--debug', debugOccurrence.value);
    } else {
      args.push('--debug');
    }
  }

  for (const config of context.consumeAllStrings('mcpConfig', 'additionalMcpConfig')) {
    args.push('--mcp-config', config);
  }

  return { mappedArgs: args, warnings };
}

function mapDroidFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];
  const warnings: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const fullAutoOccurrences = context.all('fullAuto');
  const askOccurrences = context.all('askForApproval');
  const sandboxOccurrences = context.all('sandbox');
  const approvalModeOccurrences = context.all('approvalMode');
  const approvalMode = context.latestString('approvalMode')?.toLowerCase();
  const askForApproval = context.latestString('askForApproval')?.toLowerCase();

  if (
    autoOccurrences.length > 0 ||
    fullAutoOccurrences.length > 0 ||
    askForApproval === 'never' ||
    approvalMode === 'yolo'
  ) {
    context.consume(
      ...autoOccurrences,
      ...fullAutoOccurrences,
      ...askOccurrences,
      ...sandboxOccurrences,
      ...approvalModeOccurrences,
    );
    args.push('--skip-permissions-unsafe');

    if (askOccurrences.length > 0 && askForApproval && askForApproval !== 'never') {
      warnings.push('Droid precedence: auto-approve mapping overrides unsupported ask-for-approval values.');
    }

    if (approvalModeOccurrences.length > 0 && approvalMode && approvalMode !== 'yolo') {
      warnings.push('Droid: --approval-mode is not supported by droid exec and was ignored.');
    }
  } else if (askOccurrences.length > 0 || sandboxOccurrences.length > 0 || approvalModeOccurrences.length > 0) {
    context.consume(...askOccurrences, ...sandboxOccurrences, ...approvalModeOccurrences);

    if (askOccurrences.length > 0 || sandboxOccurrences.length > 0) {
      warnings.push('Droid: --ask-for-approval and --sandbox are not supported by droid exec and were ignored.');
    }

    if (approvalModeOccurrences.length > 0 && approvalMode !== 'yolo') {
      warnings.push('Droid: --approval-mode is not supported by droid exec and was ignored.');
    }
  }

  const model = context.latestString('model');
  if (model) {
    context.consumeKeys('model');
    args.push('--model', model);
  }

  const cwd = context.latestString('workspace', 'cd');
  if (cwd) {
    context.consumeKeys('workspace', 'cd');
    args.push('--cwd', cwd);
  }

  return { mappedArgs: args, warnings };
}

function mapOpenCodeFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];
  const warnings: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const fullAutoOccurrences = context.all('fullAuto');
  const askOccurrences = context.all('askForApproval');
  const sandboxOccurrences = context.all('sandbox');
  const approvalModeOccurrences = context.all('approvalMode');
  const permissionModeOccurrences = context.all('permissionMode');

  if (
    autoOccurrences.length > 0 ||
    fullAutoOccurrences.length > 0 ||
    askOccurrences.length > 0 ||
    sandboxOccurrences.length > 0 ||
    approvalModeOccurrences.length > 0 ||
    permissionModeOccurrences.length > 0
  ) {
    context.consume(
      ...autoOccurrences,
      ...fullAutoOccurrences,
      ...askOccurrences,
      ...sandboxOccurrences,
      ...approvalModeOccurrences,
      ...permissionModeOccurrences,
    );
    warnings.push(
      'OpenCode: auto-approval, permission, and sandbox forwarding flags are not supported and were ignored.',
    );
  }

  const model = context.latestString('model');
  if (model) {
    context.consumeKeys('model');
    args.push('--model', model);
  }

  const agent = context.latestString('agent');
  if (agent) {
    context.consumeKeys('agent');
    args.push('--agent', agent);
  }

  const logLevel = context.latestString('logLevel');
  if (logLevel) {
    context.consumeKeys('logLevel');
    args.push('--log-level', logLevel);
  }

  return { mappedArgs: args, warnings };
}

function mapAmpFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];
  const warnings: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const fullAutoOccurrences = context.all('fullAuto');
  const askOccurrences = context.all('askForApproval');
  const sandboxOccurrences = context.all('sandbox');
  const approvalModeOccurrences = context.all('approvalMode');
  const approvalMode = context.latestString('approvalMode')?.toLowerCase();
  const askForApproval = context.latestString('askForApproval')?.toLowerCase();

  if (
    autoOccurrences.length > 0 ||
    fullAutoOccurrences.length > 0 ||
    askForApproval === 'never' ||
    approvalMode === 'yolo'
  ) {
    context.consume(
      ...autoOccurrences,
      ...fullAutoOccurrences,
      ...askOccurrences,
      ...sandboxOccurrences,
      ...approvalModeOccurrences,
    );
    args.push('--dangerously-allow-all');

    if (askOccurrences.length > 0 && askForApproval && askForApproval !== 'never') {
      warnings.push('Amp precedence: auto-approve mapping overrides unsupported ask-for-approval values.');
    }

    if (approvalModeOccurrences.length > 0 && approvalMode && approvalMode !== 'yolo') {
      warnings.push('Amp: --approval-mode is not supported and was ignored.');
    }
  } else if (askOccurrences.length > 0 || sandboxOccurrences.length > 0 || approvalModeOccurrences.length > 0) {
    context.consume(...askOccurrences, ...sandboxOccurrences, ...approvalModeOccurrences);

    if (askOccurrences.length > 0 || sandboxOccurrences.length > 0) {
      warnings.push('Amp: --ask-for-approval and --sandbox are not supported and were ignored.');
    }

    if (approvalModeOccurrences.length > 0 && approvalMode) {
      warnings.push('Amp: --approval-mode is not supported and was ignored.');
    }
  }

  return { mappedArgs: args, warnings };
}

function mapCopilotFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const allowAllOccurrences = context.all('allowAll');

  if (allowAllOccurrences.length > 0 && autoOccurrences.length === allowAllOccurrences.length) {
    context.consume(...allowAllOccurrences);
    args.push('--allow-all');
  } else if (autoOccurrences.length > 0) {
    context.consume(...autoOccurrences);
    args.push('--yolo');
  }

  const model = context.latestString('model');
  if (model) {
    context.consumeKeys('model');
    args.push('--model', model);
  }

  for (const directory of context.consumeAllCsvStrings('addDir', 'includeDirectories')) {
    args.push('--add-dir', directory);
  }

  for (const tool of context.consumeAllCsvStrings('allowedTools', 'allowTool')) {
    args.push('--allow-tool', tool);
  }

  for (const tool of context.consumeAllCsvStrings('disallowedTools', 'denyTool')) {
    args.push('--deny-tool', tool);
  }

  const agent = context.latestString('agent');
  if (agent) {
    context.consumeKeys('agent');
    args.push('--agent', agent);
  }

  const logLevel = context.latestString('logLevel');
  if (logLevel) {
    context.consumeKeys('logLevel');
    args.push('--log-level', logLevel);
  }

  for (const config of context.consumeAllStrings('additionalMcpConfig', 'mcpConfig')) {
    args.push('--additional-mcp-config', config);
  }

  return { mappedArgs: args };
}

function mapCursorAgentFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const fullAutoOccurrences = context.all('fullAuto');
  if (autoOccurrences.length > 0 || fullAutoOccurrences.length > 0) {
    context.consume(...autoOccurrences, ...fullAutoOccurrences);
    args.push('--yolo');
  }

  const model = context.latestString('model');
  if (model) {
    context.consumeKeys('model');
    args.push('--model', model);
  }

  const sandboxOccurrence = context.latest('sandbox');
  if (sandboxOccurrence) {
    const normalized = normalizeAgentSandbox(sandboxOccurrence.value);
    if (normalized) {
      context.consumeKeys('sandbox');
      args.push('--sandbox', normalized);
    }
  }

  const planOccurrences = normalizePlanOccurrences(context);
  if (planOccurrences.length > 0) {
    context.consume(...planOccurrences);
    args.push('--plan');
  }

  const workspace = context.latestString('workspace', 'cd');
  if (workspace) {
    context.consumeKeys('workspace', 'cd');
    args.push('--workspace', workspace);
  }

  if (context.consumeAnyBoolean('approveMcps')) {
    args.push('--approve-mcps');
  }

  return { mappedArgs: args };
}

function mapKimiFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];
  const warnings: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const fullAutoOccurrences = context.all('fullAuto');
  const askOccurrences = context.all('askForApproval');
  const sandboxOccurrences = context.all('sandbox');
  const approvalMode = context.latestString('approvalMode')?.toLowerCase();
  const askForApproval = context.latestString('askForApproval')?.toLowerCase();

  if (
    autoOccurrences.length > 0 ||
    fullAutoOccurrences.length > 0 ||
    approvalMode === 'yolo' ||
    askForApproval === 'never'
  ) {
    context.consume(
      ...autoOccurrences,
      ...fullAutoOccurrences,
      ...askOccurrences,
      ...sandboxOccurrences,
      ...context.all('approvalMode'),
    );
    args.push('--yolo');

    if (askOccurrences.length > 0 && askForApproval && askForApproval !== 'never') {
      warnings.push('Kimi precedence: mapped auto-approve behavior overrides unsupported ask-for-approval values.');
    }
  } else if (askOccurrences.length > 0 || sandboxOccurrences.length > 0 || context.all('approvalMode').length > 0) {
    context.consume(...askOccurrences, ...sandboxOccurrences, ...context.all('approvalMode'));
    warnings.push('Kimi: --ask-for-approval, --approval-mode, and --sandbox are not supported and were ignored.');
  }

  const model = context.latestString('model');
  if (model) {
    context.consumeKeys('model');
    args.push('--model', model);
  }

  for (const directory of context.consumeAllCsvStrings('addDir', 'includeDirectories')) {
    args.push('--add-dir', directory);
  }

  const workDir = context.latestString('workspace', 'cd');
  if (workDir) {
    context.consumeKeys('workspace', 'cd');
    args.push('--work-dir', workDir);
  }

  const agent = context.latestString('agent');
  if (agent) {
    context.consumeKeys('agent');
    args.push('--agent', agent);
  }

  return { mappedArgs: args, warnings };
}

function mapKiroFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];
  const warnings: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const fullAutoOccurrences = context.all('fullAuto');
  const askOccurrences = context.all('askForApproval');
  const sandboxOccurrences = context.all('sandbox');
  const approvalMode = context.latestString('approvalMode')?.toLowerCase();
  const askForApproval = context.latestString('askForApproval')?.toLowerCase();

  if (
    autoOccurrences.length > 0 ||
    fullAutoOccurrences.length > 0 ||
    approvalMode === 'yolo' ||
    askForApproval === 'never'
  ) {
    context.consume(
      ...autoOccurrences,
      ...fullAutoOccurrences,
      ...askOccurrences,
      ...sandboxOccurrences,
      ...context.all('approvalMode'),
    );
    args.push('--trust-all-tools');
  } else if (askOccurrences.length > 0 || sandboxOccurrences.length > 0 || context.all('approvalMode').length > 0) {
    context.consume(...askOccurrences, ...sandboxOccurrences, ...context.all('approvalMode'));
    warnings.push('Kiro: --ask-for-approval, --approval-mode, and --sandbox are not supported and were ignored.');
  }

  const agent = context.latestString('agent');
  if (agent) {
    context.consumeKeys('agent');
    args.push('--agent', agent);
  }

  return { mappedArgs: args, warnings };
}

function mapCrushFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];
  const warnings: string[] = [];

  const autoOccurrences = collectAutoApproveOccurrences(context);
  const fullAutoOccurrences = context.all('fullAuto');
  const askOccurrences = context.all('askForApproval');
  const sandboxOccurrences = context.all('sandbox');
  const approvalMode = context.latestString('approvalMode')?.toLowerCase();
  const askForApproval = context.latestString('askForApproval')?.toLowerCase();

  if (
    autoOccurrences.length > 0 ||
    fullAutoOccurrences.length > 0 ||
    approvalMode === 'yolo' ||
    askForApproval === 'never'
  ) {
    context.consume(
      ...autoOccurrences,
      ...fullAutoOccurrences,
      ...askOccurrences,
      ...sandboxOccurrences,
      ...context.all('approvalMode'),
    );
    args.push('--yolo');
  } else if (askOccurrences.length > 0 || sandboxOccurrences.length > 0 || context.all('approvalMode').length > 0) {
    context.consume(...askOccurrences, ...sandboxOccurrences, ...context.all('approvalMode'));
    warnings.push('Crush: --ask-for-approval, --approval-mode, and --sandbox are not supported and were ignored.');
  }

  return { mappedArgs: args, warnings };
}

// ── Claude Code ──────────────────────────────────────────────────────
register({
  name: 'claude',
  label: 'Claude Code',
  color: chalk.blue,
  storagePath: '~/.claude/projects/',
  envVar: 'CLAUDE_CONFIG_DIR',
  binaryName: 'claude',
  parseSessions: parseClaudeSessions,
  supportsCwdLookup: true,
  extractContext: extractClaudeContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `claude --resume ${s.id}`,
  mapHandoffFlags: mapClaudeFlags,
});

// ── Codex CLI ────────────────────────────────────────────────────────
register({
  name: 'codex',
  label: 'Codex CLI',
  color: chalk.magenta,
  storagePath: '~/.codex/sessions/',
  envVar: 'CODEX_HOME',
  binaryName: 'codex',
  parseSessions: parseCodexSessions,
  extractContext: extractCodexContext,
  nativeResumeArgs: (s) => ['resume', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `codex resume ${s.id}`,
  mapHandoffFlags: mapCodexFlags,
});

// ── GitHub Copilot CLI ───────────────────────────────────────────────
register({
  name: 'copilot',
  label: 'GitHub Copilot CLI',
  color: chalk.green,
  storagePath: '~/.copilot/session-state/',
  envVar: 'COPILOT_HOME',
  binaryName: 'copilot',
  parseSessions: parseCopilotSessions,
  extractContext: extractCopilotContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => ['-i', prompt],
  resumeCommandDisplay: (s) => `copilot --resume ${s.id}`,
  mapHandoffFlags: mapCopilotFlags,
});

// ── Gemini CLI ───────────────────────────────────────────────────────
register({
  name: 'gemini',
  label: 'Gemini CLI',
  color: chalk.cyan,
  storagePath: '~/.gemini/tmp/*/chats/',
  envVar: 'GEMINI_CLI_HOME',
  binaryName: 'gemini',
  parseSessions: parseGeminiSessions,
  extractContext: extractGeminiContext,
  nativeResumeArgs: () => ['--resume'],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: () => `gemini --resume`,
  mapHandoffFlags: mapGeminiFlags,
});

// ── OpenCode ─────────────────────────────────────────────────────────
register({
  name: 'opencode',
  label: 'OpenCode',
  color: chalk.yellow,
  storagePath: '~/.local/share/opencode/storage/',
  envVar: 'XDG_DATA_HOME',
  binaryName: 'opencode',
  parseSessions: parseOpenCodeSessions,
  extractContext: extractOpenCodeContext,
  nativeResumeArgs: (s) => ['--session', s.id],
  crossToolArgs: (prompt) => ['run', prompt],
  resumeCommandDisplay: (s) => `opencode --session ${s.id}`,
  mapHandoffFlags: mapOpenCodeFlags,
});

// ── Factory Droid ────────────────────────────────────────────────────
register({
  name: 'droid',
  label: 'Factory Droid',
  color: chalk.red,
  storagePath: '~/.factory/projects/ (fallback: ~/.factory/sessions/)',
  binaryName: 'droid',
  parseSessions: parseDroidSessions,
  extractContext: extractDroidContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => ['exec', prompt],
  resumeCommandDisplay: (s) => `droid --resume ${s.id}`,
  mapHandoffFlags: mapDroidFlags,
});

// ── Cursor AI (Agent CLI) ────────────────────────────────────────────
register({
  name: 'cursor',
  label: 'Cursor AI',
  color: chalk.blueBright,
  storagePath: '~/.cursor/projects/*/agent-transcripts/',
  binaryName: 'cursor-agent',
  binaryFallbacks: ['agent'],
  parseSessions: parseCursorSessions,
  extractContext: extractCursorContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `cursor-agent --resume ${s.id} (or: agent --resume ${s.id})`,
  mapHandoffFlags: mapCursorAgentFlags,
});

// ── Amp CLI ──────────────────────────────────────────────────────────
register({
  name: 'amp',
  label: 'Amp CLI',
  color: chalk.hex('#FF6B35'),
  storagePath: '~/.local/share/amp/threads/',
  envVar: 'XDG_DATA_HOME',
  binaryName: 'amp',
  parseSessions: parseAmpSessions,
  extractContext: extractAmpContext,
  nativeResumeArgs: (s) => ['--thread', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `amp --thread ${s.id}`,
  mapHandoffFlags: mapAmpFlags,
});

// ── Kiro IDE ─────────────────────────────────────────────────────────
register({
  name: 'kiro',
  label: 'Kiro IDE',
  color: chalk.hex('#7B68EE'),
  storagePath: '~/Library/Application Support/Kiro/workspace-sessions/',
  binaryName: 'kiro',
  parseSessions: parseKiroSessions,
  extractContext: extractKiroContext,
  nativeResumeArgs: () => [],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: () => `kiro`,
  mapHandoffFlags: mapKiroFlags,
});

// ── Crush CLI ────────────────────────────────────────────────────────
register({
  name: 'crush',
  label: 'Crush CLI',
  color: chalk.hex('#E63946'),
  storagePath: '~/.crush/crush.db',
  binaryName: 'crush',
  // The Crush parser resolves its database path from any of these env vars
  // (see getCrushDbCandidates in src/parsers/crush.ts). Declaring them here
  // ensures the unified session index cache fingerprint invalidates whenever
  // any of them change.
  extraEnvVars: ['CRUSH_DB', 'CRUSH_DB_PATH', 'CRUSH_DATA_DIR', 'CRUSH_GLOBAL_DATA', 'XDG_DATA_HOME'],
  parseSessions: parseCrushSessions,
  extractContext: extractCrushContext,
  nativeResumeArgs: (s) => ['--session', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `crush --session ${s.id}`,
  mapHandoffFlags: mapCrushFlags,
});

// ── Cline ────────────────────────────────────────────────────────────
register({
  name: 'cline',
  label: 'Cline',
  color: chalk.hex('#00D4AA'),
  storagePath: '~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/',
  envVar: 'CLINE_STORAGE_PATH',
  extraEnvVars: ['CONTINUES_CLINE_STORAGE_PATH'],
  binaryName: 'code',
  parseSessions: parseClineSessions,
  extractContext: extractClineContext,
  nativeResumeArgs: () => [],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: () => `code`,
});

// ── Roo Code ─────────────────────────────────────────────────────────
register({
  name: 'roo-code',
  label: 'Roo Code',
  color: chalk.hex('#FF8C42'),
  storagePath: '~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/',
  envVar: 'ROO_CODE_STORAGE_PATH',
  extraEnvVars: ['ROO_CLINE_STORAGE_PATH', 'CONTINUES_ROO_CODE_STORAGE_PATH'],
  binaryName: 'code',
  parseSessions: parseRooCodeSessions,
  extractContext: extractRooCodeContext,
  nativeResumeArgs: () => [],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: () => `code`,
});

// ── Kilo Code ────────────────────────────────────────────────────────
register({
  name: 'kilo-code',
  label: 'Kilo Code',
  color: chalk.hex('#6C5CE7'),
  storagePath: '~/.local/share/kilo/kilo.db (fallback: VS Code globalStorage/kilocode.kilo-code/tasks/)',
  envVar: 'KILO_DB',
  extraEnvVars: [
    'XDG_DATA_HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'KILO_CODE_STORAGE_PATH',
    'CONTINUES_KILO_CODE_STORAGE_PATH',
  ],
  binaryName: 'code',
  parseSessions: parseKiloCodeSessions,
  extractContext: extractKiloCodeContext,
  nativeResumeArgs: () => [],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: () => `code`,
});

// ── Antigravity ──────────────────────────────────────────────────────
register({
  name: 'antigravity',
  label: 'Antigravity',
  color: chalk.hex('#A8DADC'),
  storagePath: '~/.gemini/antigravity/',
  envVar: 'ANTIGRAVITY_HOME',
  // Antigravity's parser falls back to GEMINI_CLI_HOME when ANTIGRAVITY_HOME
  // is unset, so changes to that var must also invalidate the index cache.
  extraEnvVars: ['GEMINI_CLI_HOME', 'ANTIGRAVITY_STATE_DB'],
  binaryName: 'antigravity',
  parseSessions: parseAntigravitySessions,
  extractContext: extractAntigravityContext,
  nativeResumeArgs: () => [],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: () => `antigravity`,
});

// ── Kimi CLI ──────────────────────────────────────────────────────────
register({
  name: 'kimi',
  label: 'Kimi CLI',
  color: chalk.hex('#00D4AA'),
  storagePath: '~/.kimi/sessions/',
  envVar: 'KIMI_SHARE_DIR',
  binaryName: 'kimi',
  parseSessions: parseKimiSessions,
  extractContext: extractKimiContext,
  nativeResumeArgs: (s) => ['--session', s.id],
  crossToolArgs: (prompt) => ['--prompt', prompt],
  resumeCommandDisplay: (s) => `kimi --session ${s.id}`,
  mapHandoffFlags: mapKimiFlags,
});

// ── Qwen Code ────────────────────────────────────────────────────────
register({
  name: 'qwen-code',
  label: 'Qwen Code',
  // Upstream Qwen Code (packages/core/src/config/storage.ts: Storage.getRuntimeBaseDir)
  // resolves the runtime base via QWEN_RUNTIME_DIR before falling back to
  // ~/.qwen, then writes chats under <runtime-base>/projects/<sanitized-cwd>/chats/.
  // QWEN_HOME is a continues-side override kept for fixtures and sandboxed installs;
  // both must invalidate the index cache when changed.
  color: chalk.hex('#6366F1'),
  storagePath: '$QWEN_RUNTIME_DIR/projects/*/chats/ (default: ~/.qwen/projects/*/chats/)',
  envVar: 'QWEN_RUNTIME_DIR',
  extraEnvVars: ['QWEN_HOME'],
  binaryName: 'qwen',
  parseSessions: parseQwenCodeSessions,
  extractContext: extractQwenCodeContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `qwen --resume ${s.id}`,
  mapHandoffFlags: mapGeminiFlags,
});

// ── Completeness assertion ──────────────────────────────────────────
// Runs at module load — if a new tool is added to TOOL_NAMES but not
// registered here, this throws immediately with a clear message.
const missing = TOOL_NAMES.filter((name) => !(name in _adapters));
if (missing.length > 0) {
  throw new Error(`Registry incomplete: missing adapter(s) for ${missing.join(', ')}`);
}

// ── Exports ──────────────────────────────────────────────────────────

/** Type-safe adapter lookup — completeness proven by runtime assertion above */
export const adapters: Readonly<Record<SessionSource, ToolAdapter>> = _adapters as Record<SessionSource, ToolAdapter>;

/** Ordered list of all tool names — derived from the canonical TOOL_NAMES array */
export const ALL_TOOLS: readonly SessionSource[] = TOOL_NAMES;

/** Formatted help string for --source options */
export const SOURCE_HELP = `Filter by source (${ALL_TOOLS.join(', ')})`;

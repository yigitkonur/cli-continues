import chalk from 'chalk';
import type { SessionContext, SessionSource, UnifiedSession } from '../types/index.js';
import type { VerbosityConfig } from '../config/index.js';
import { TOOL_NAMES } from '../types/tool-names.js';
import {
  type FlagOccurrence,
  type ForwardFlagMapContext,
  type ForwardFlagMapper,
  type ForwardMapResult,
  normalizeAgentSandbox,
} from '../utils/forward-flags.js';
import { extractClaudeContext, parseClaudeSessions } from './claude.js';
import { extractCodexContext, parseCodexSessions } from './codex.js';
import { extractCopilotContext, parseCopilotSessions } from './copilot.js';
import { extractCursorContext, parseCursorSessions } from './cursor.js';
import { extractDroidContext, parseDroidSessions } from './droid.js';
import { extractGeminiContext, parseGeminiSessions } from './gemini.js';
import { extractOpenCodeContext, parseOpenCodeSessions } from './opencode.js';
import { extractAmpContext, parseAmpSessions } from './amp.js';
import { extractKiroContext, parseKiroSessions } from './kiro.js';
import { extractCrushContext, parseCrushSessions } from './crush.js';
import {
  extractClineContext, parseClineSessions,
  extractRooCodeContext, parseRooCodeSessions,
  extractKiloCodeContext, parseKiloCodeSessions,
} from './cline.js';
import { extractAntigravityContext, parseAntigravitySessions } from './antigravity.js';
import { extractKimiContext, parseKimiSessions } from './kimi.js';

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
  /** CLI binary name for availability checks and spawning */
  binaryName: string;
  /** Discover and index all sessions */
  parseSessions: () => Promise<UnifiedSession[]>;
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

function mapDroidFlags(_context: ForwardFlagMapContext): ForwardMapResult {
  return { mappedArgs: [] };
}

function mapOpenCodeFlags(context: ForwardFlagMapContext): ForwardMapResult {
  const args: string[] = [];

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

  return { mappedArgs: args };
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
  if (autoOccurrences.length > 0) {
    context.consume(...autoOccurrences);
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

// ── Claude Code ──────────────────────────────────────────────────────
register({
  name: 'claude',
  label: 'Claude Code',
  color: chalk.blue,
  storagePath: '~/.claude/projects/',
  envVar: 'CLAUDE_CONFIG_DIR',
  binaryName: 'claude',
  parseSessions: parseClaudeSessions,
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
  nativeResumeArgs: (s) => ['-c', `experimental_resume=${s.originalPath}`],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `codex -c experimental_resume="${s.originalPath}"`,
  mapHandoffFlags: mapCodexFlags,
});

// ── GitHub Copilot CLI ───────────────────────────────────────────────
register({
  name: 'copilot',
  label: 'GitHub Copilot CLI',
  color: chalk.green,
  storagePath: '~/.copilot/session-state/',
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
  nativeResumeArgs: () => ['--continue'],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: () => `gemini --continue`,
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
  crossToolArgs: (prompt) => ['--prompt', prompt],
  resumeCommandDisplay: (s) => `opencode --session ${s.id}`,
  mapHandoffFlags: mapOpenCodeFlags,
});

// ── Factory Droid ────────────────────────────────────────────────────
register({
  name: 'droid',
  label: 'Factory Droid',
  color: chalk.red,
  storagePath: '~/.factory/sessions/',
  binaryName: 'droid',
  parseSessions: parseDroidSessions,
  extractContext: extractDroidContext,
  nativeResumeArgs: (s) => ['-s', s.id],
  crossToolArgs: (prompt) => ['exec', prompt],
  resumeCommandDisplay: (s) => `droid -s ${s.id}`,
  mapHandoffFlags: mapDroidFlags,
});

// ── Cursor AI (Agent CLI) ────────────────────────────────────────────
register({
  name: 'cursor',
  label: 'Cursor AI',
  color: chalk.blueBright,
  storagePath: '~/.cursor/projects/*/agent-transcripts/',
  binaryName: 'agent',
  parseSessions: parseCursorSessions,
  extractContext: extractCursorContext,
  nativeResumeArgs: (s) => ['--resume', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `agent --resume ${s.id}`,
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
});

// ── Crush CLI ────────────────────────────────────────────────────────
register({
  name: 'crush',
  label: 'Crush CLI',
  color: chalk.hex('#E63946'),
  storagePath: '~/.crush/crush.db',
  binaryName: 'crush',
  parseSessions: parseCrushSessions,
  extractContext: extractCrushContext,
  nativeResumeArgs: (s) => ['--session', s.id],
  crossToolArgs: (prompt) => [prompt],
  resumeCommandDisplay: (s) => `crush --session ${s.id}`,
});

// ── Cline ────────────────────────────────────────────────────────────
register({
  name: 'cline',
  label: 'Cline',
  color: chalk.hex('#00D4AA'),
  storagePath: '~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/',
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
  storagePath: '~/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks/',
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
  storagePath: '~/.gemini/antigravity/code_tracker/',
  envVar: 'GEMINI_CLI_HOME',
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
  binaryName: 'kimi',
  parseSessions: parseKimiSessions,
  extractContext: extractKimiContext,
  nativeResumeArgs: (s) => ['--session', s.id],
  crossToolArgs: (prompt) => ['--prompt', prompt + '\n\nWhat would you like me to do next?'],
  resumeCommandDisplay: (s) => `kimi --session ${s.id}`,
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

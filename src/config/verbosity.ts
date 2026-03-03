/**
 * Unified verbosity configuration for continues.
 *
 * Controls all truncation limits, sample counts, and feature flags
 * across every parser and renderer. Replaces dozens of hardcoded
 * `.slice(0, N)` limits with a single, user-configurable system.
 *
 * Config resolution order:
 *   1. Explicit `--config <path>` CLI flag
 *   2. `.continues.yml` in CWD
 *   3. `~/.continues/config.yml`
 *   4. `standard` preset (built-in default)
 *
 * Users can override any subset of fields — unspecified fields
 * inherit from the chosen preset (or `standard` if none specified).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import YAML from 'yaml';
import { logger } from '../logger.js';

// ── Zod Schema ──────────────────────────────────────────────────────────────

const ShellConfigSchema = z.object({
  maxSamples: z.number().int().min(0).default(8),
  stdoutLines: z.number().int().min(0).default(5),
  stderrLines: z.number().int().min(0).default(5),
  maxChars: z.number().int().min(0).default(2000),
  showCommand: z.boolean().default(true),
  showExitCode: z.boolean().default(true),
});

const ReadConfigSchema = z.object({
  maxSamples: z.number().int().min(0).default(20),
  maxChars: z.number().int().min(0).default(0),
  showLineRange: z.boolean().default(true),
});

const WriteConfigSchema = z.object({
  maxSamples: z.number().int().min(0).default(5),
  diffLines: z.number().int().min(0).default(200),
  maxChars: z.number().int().min(0).default(5000),
});

const EditConfigSchema = z.object({
  maxSamples: z.number().int().min(0).default(5),
  diffLines: z.number().int().min(0).default(200),
  maxChars: z.number().int().min(0).default(5000),
});

const GrepConfigSchema = z.object({
  maxSamples: z.number().int().min(0).default(10),
  maxChars: z.number().int().min(0).default(500),
  showPattern: z.boolean().default(true),
  matchLines: z.number().int().min(0).default(5),
});

const ThinkingToolsConfigSchema = z.object({
  extractReasoning: z.boolean().default(true),
  maxReasoningChars: z.number().int().min(0).default(500),
});

const McpConfigSchema = z.object({
  maxSamplesPerNamespace: z.number().int().min(0).default(5),
  paramChars: z.number().int().min(0).default(100),
  resultChars: z.number().int().min(0).default(100),
  thinkingTools: ThinkingToolsConfigSchema,
});

const TaskConfigSchema = z.object({
  maxSamples: z.number().int().min(0).default(5),
  includeSubagentResults: z.boolean().default(true),
  subagentResultChars: z.number().int().min(0).default(500),
  recurseSubagents: z.boolean().default(false),
});

const ThinkingConfigSchema = z.object({
  include: z.boolean().default(true),
  maxChars: z.number().int().min(0).default(1000),
  maxHighlights: z.number().int().min(0).default(5),
});

const CompactSummaryConfigSchema = z.object({
  maxChars: z.number().int().min(0).default(500),
});

const PendingTasksConfigSchema = z.object({
  extractFromThinking: z.boolean().default(true),
  extractFromSubagents: z.boolean().default(true),
  maxTasks: z.number().int().min(0).default(10),
});

const ClaudeAgentConfigSchema = z.object({
  filterProgressEvents: z.boolean().default(true),
  parseSubagents: z.boolean().default(true),
  parseToolResultsDir: z.boolean().default(true),
  separateHumanFromToolResults: z.boolean().default(true),
  chainCompactedHistory: z.boolean().default(true),
  chainMaxDepth: z.number().int().min(0).default(2),
  chainSummaryChars: z.number().int().min(0).default(800),
});

const AgentFlagsSchema = z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]));

const AgentsConfigSchema = z
  .object({
    claude: ClaudeAgentConfigSchema,
  })
  .catchall(AgentFlagsSchema.optional());

const PresetNameSchema = z.enum(['minimal', 'standard', 'verbose', 'full']);

export const VerbosityConfigSchema = z.object({
  preset: PresetNameSchema.default('standard'),
  recentMessages: z.number().int().min(0).default(10),
  maxMessageChars: z.number().int().min(0).default(500),
  shell: ShellConfigSchema,
  read: ReadConfigSchema,
  write: WriteConfigSchema,
  edit: EditConfigSchema,
  grep: GrepConfigSchema,
  mcp: McpConfigSchema,
  task: TaskConfigSchema,
  thinking: ThinkingConfigSchema,
  compactSummary: CompactSummaryConfigSchema,
  pendingTasks: PendingTasksConfigSchema,
  agents: AgentsConfigSchema,
});

// ── TypeScript Type ─────────────────────────────────────────────────────────

export type PresetName = z.infer<typeof PresetNameSchema>;
export type VerbosityConfig = z.infer<typeof VerbosityConfigSchema>;

// ── Presets ──────────────────────────────────────────────────────────────────

/** Low output (~2KB). Essentials only. */
const MINIMAL_PRESET: VerbosityConfig = {
  preset: 'minimal',
  recentMessages: 3,
  maxMessageChars: 200,
  shell: {
    maxSamples: 3,
    stdoutLines: 3,
    stderrLines: 3,
    maxChars: 500,
    showCommand: true,
    showExitCode: true,
  },
  read: {
    maxSamples: 5,
    maxChars: 0, // path only
    showLineRange: false,
  },
  write: {
    maxSamples: 3,
    diffLines: 20,
    maxChars: 1000,
  },
  edit: {
    maxSamples: 3,
    diffLines: 20,
    maxChars: 1000,
  },
  grep: {
    maxSamples: 3,
    maxChars: 200,
    showPattern: true,
    matchLines: 2,
  },
  mcp: {
    maxSamplesPerNamespace: 1,
    paramChars: 50,
    resultChars: 50,
    thinkingTools: {
      extractReasoning: false,
      maxReasoningChars: 0,
    },
  },
  task: {
    maxSamples: 2,
    includeSubagentResults: false,
    subagentResultChars: 0,
    recurseSubagents: false,
  },
  thinking: {
    include: false,
    maxChars: 0,
    maxHighlights: 0,
  },
  compactSummary: {
    maxChars: 200,
  },
  pendingTasks: {
    extractFromThinking: false,
    extractFromSubagents: false,
    maxTasks: 5,
  },
  agents: {
    claude: {
      filterProgressEvents: true,
      parseSubagents: false,
      parseToolResultsDir: false,
      separateHumanFromToolResults: false,
      chainCompactedHistory: true,
      chainMaxDepth: 1,
      chainSummaryChars: 300,
    },
  },
};

/** Current behavior improved (~8KB). Good default for most handoffs. */
const STANDARD_PRESET: VerbosityConfig = {
  preset: 'standard',
  recentMessages: 10,
  maxMessageChars: 500,
  shell: {
    maxSamples: 8,
    stdoutLines: 5,
    stderrLines: 5,
    maxChars: 2000,
    showCommand: true,
    showExitCode: true,
  },
  read: {
    maxSamples: 20,
    maxChars: 0, // path only
    showLineRange: true,
  },
  write: {
    maxSamples: 5,
    diffLines: 200,
    maxChars: 5000,
  },
  edit: {
    maxSamples: 5,
    diffLines: 200,
    maxChars: 5000,
  },
  grep: {
    maxSamples: 10,
    maxChars: 500,
    showPattern: true,
    matchLines: 5,
  },
  mcp: {
    maxSamplesPerNamespace: 5,
    paramChars: 100,
    resultChars: 100,
    thinkingTools: {
      extractReasoning: true,
      maxReasoningChars: 500,
    },
  },
  task: {
    maxSamples: 5,
    includeSubagentResults: true,
    subagentResultChars: 500,
    recurseSubagents: false,
  },
  thinking: {
    include: true,
    maxChars: 1000,
    maxHighlights: 5,
  },
  compactSummary: {
    maxChars: 500,
  },
  pendingTasks: {
    extractFromThinking: true,
    extractFromSubagents: true,
    maxTasks: 10,
  },
  agents: {
    claude: {
      filterProgressEvents: true,
      parseSubagents: true,
      parseToolResultsDir: true,
      separateHumanFromToolResults: true,
      chainCompactedHistory: true,
      chainMaxDepth: 2,
      chainSummaryChars: 800,
    },
  },
};

/** Rich context (~30KB). Useful for complex multi-file tasks. */
const VERBOSE_PRESET: VerbosityConfig = {
  preset: 'verbose',
  recentMessages: 20,
  maxMessageChars: 2000,
  shell: {
    maxSamples: 15,
    stdoutLines: 20,
    stderrLines: 20,
    maxChars: 8000,
    showCommand: true,
    showExitCode: true,
  },
  read: {
    maxSamples: 50,
    maxChars: 500,
    showLineRange: true,
  },
  write: {
    maxSamples: 15,
    diffLines: 500,
    maxChars: 10000,
  },
  edit: {
    maxSamples: 15,
    diffLines: 500,
    maxChars: 10000,
  },
  grep: {
    maxSamples: 20,
    maxChars: 1000,
    showPattern: true,
    matchLines: 10,
  },
  mcp: {
    maxSamplesPerNamespace: 10,
    paramChars: 500,
    resultChars: 1000,
    thinkingTools: {
      extractReasoning: true,
      maxReasoningChars: 2000,
    },
  },
  task: {
    maxSamples: 10,
    includeSubagentResults: true,
    subagentResultChars: 2000,
    recurseSubagents: true,
  },
  thinking: {
    include: true,
    maxChars: 5000,
    maxHighlights: 10,
  },
  compactSummary: {
    maxChars: 1000,
  },
  pendingTasks: {
    extractFromThinking: true,
    extractFromSubagents: true,
    maxTasks: 20,
  },
  agents: {
    claude: {
      filterProgressEvents: true,
      parseSubagents: true,
      parseToolResultsDir: true,
      separateHumanFromToolResults: true,
      chainCompactedHistory: true,
      chainMaxDepth: 4,
      chainSummaryChars: 2000,
    },
  },
};

/** Everything (~unlimited). Full session data, no truncation. */
const FULL_PRESET: VerbosityConfig = {
  preset: 'full',
  recentMessages: 50,
  maxMessageChars: 10000,
  shell: {
    maxSamples: 999,
    stdoutLines: 100,
    stderrLines: 100,
    maxChars: 50000,
    showCommand: true,
    showExitCode: true,
  },
  read: {
    maxSamples: 999,
    maxChars: 10000,
    showLineRange: true,
  },
  write: {
    maxSamples: 999,
    diffLines: 999,
    maxChars: 50000,
  },
  edit: {
    maxSamples: 999,
    diffLines: 999,
    maxChars: 50000,
  },
  grep: {
    maxSamples: 999,
    maxChars: 10000,
    showPattern: true,
    matchLines: 50,
  },
  mcp: {
    maxSamplesPerNamespace: 999,
    paramChars: 10000,
    resultChars: 10000,
    thinkingTools: {
      extractReasoning: true,
      maxReasoningChars: 10000,
    },
  },
  task: {
    maxSamples: 999,
    includeSubagentResults: true,
    subagentResultChars: 10000,
    recurseSubagents: true,
  },
  thinking: {
    include: true,
    maxChars: 50000,
    maxHighlights: 50,
  },
  compactSummary: {
    maxChars: 5000,
  },
  pendingTasks: {
    extractFromThinking: true,
    extractFromSubagents: true,
    maxTasks: 100,
  },
  agents: {
    claude: {
      filterProgressEvents: false,
      parseSubagents: true,
      parseToolResultsDir: true,
      separateHumanFromToolResults: true,
      chainCompactedHistory: true,
      chainMaxDepth: 8,
      chainSummaryChars: 5000,
    },
  },
};

const PRESETS: Record<PresetName, VerbosityConfig> = {
  minimal: MINIMAL_PRESET,
  standard: STANDARD_PRESET,
  verbose: VERBOSE_PRESET,
  full: FULL_PRESET,
};

// ── Deep Merge ──────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `overrides` into `base`.
 * - Plain objects are merged key-by-key (override wins for leaf values).
 * - Arrays and primitives in overrides replace the base value entirely.
 * - Keys not present in overrides are kept from base.
 */
function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Record<string, unknown>): T {
  const result = { ...base } as Record<string, unknown>;

  for (const key of Object.keys(overrides)) {
    const baseVal = result[key];
    const overVal = overrides[key];

    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal);
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }

  return result as T;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Get a built-in preset by name. Throws on unknown preset. */
export function getPreset(name: string): VerbosityConfig {
  const key = name as PresetName;
  const preset = PRESETS[key];
  if (!preset) {
    throw new Error(`Unknown verbosity preset "${name}". Valid presets: ${Object.keys(PRESETS).join(', ')}`);
  }
  return structuredClone(preset);
}

/** Deep-merge user overrides onto a base config. */
export function mergeConfig(base: VerbosityConfig, overrides: Partial<VerbosityConfig>): VerbosityConfig {
  return deepMerge(base, overrides as Record<string, unknown>);
}

/**
 * Parse and validate raw user YAML/JSON data into a VerbosityConfig.
 * Unknown fields are stripped. Invalid fields fall back to defaults from the
 * selected preset (or `standard` if no preset is specified).
 */
function parseUserConfig(raw: unknown): VerbosityConfig {
  if (!isPlainObject(raw)) {
    logger.warn('Config file is not a plain object, using standard preset');
    return getPreset('standard');
  }

  // Determine which preset to use as the base
  const presetName = typeof raw.preset === 'string' && raw.preset in PRESETS ? (raw.preset as PresetName) : 'standard';
  const base = getPreset(presetName);

  // Merge user overrides onto the preset base, then validate
  const merged = deepMerge(base, raw as Record<string, unknown>);
  const result = VerbosityConfigSchema.safeParse(merged);

  if (result.success) {
    return result.data;
  }

  // Validation failed — log issues and return the base preset
  logger.warn('Config validation errors, falling back to preset defaults:', result.error.issues.map((i) => i.message).join('; '));
  return base;
}

/**
 * Load verbosity config from disk using the resolution chain:
 *   1. Explicit path (from `--config` CLI flag)
 *   2. `.continues.yml` in the current working directory
 *   3. `~/.continues/config.yml` in the user's home directory
 *   4. Built-in `standard` preset
 *
 * Partial configs are deep-merged over the selected preset defaults,
 * so users only need to specify the fields they want to change.
 */
export function loadConfig(configPath?: string): VerbosityConfig {
  const candidates: string[] = [];

  if (configPath) {
    candidates.push(path.resolve(configPath));
  }

  candidates.push(path.resolve(process.cwd(), '.continues.yml'));
  candidates.push(path.join(os.homedir(), '.continues', 'config.yml'));

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      logger.debug('Config not found:', filePath);
      continue;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const raw = YAML.parse(content) as unknown;
      logger.info('Loaded config from', filePath);
      return parseUserConfig(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to read config at ${filePath}: ${msg}`);
      // Continue to next candidate
    }
  }

  logger.debug('No config file found, using standard preset');
  return getPreset('standard');
}

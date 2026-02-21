/**
 * E2E test harness: extracts handoff markdown from real sessions,
 * injects into each target tool non-interactively, and validates
 * the target tool acknowledges the previous conversation.
 *
 * Non-interactive modes:
 *   claude -p "prompt"
 *   gemini -p "prompt"
 *   codex exec "prompt"
 *   opencode run "message"
 *   copilot -i "prompt" (falls back to stdin)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  extractClaudeContext,
  extractCodexContext,
  extractCopilotContext,
  extractCursorContext,
  extractDroidContext,
  extractGeminiContext,
  extractOpenCodeContext,
  parseClaudeSessions,
  parseCodexSessions,
  parseCopilotSessions,
  parseCursorSessions,
  parseDroidSessions,
  parseGeminiSessions,
  parseOpenCodeSessions,
} from '../parsers/index.js';
import type { SessionContext, SessionSource, UnifiedSession } from '../types/index.js';

const ALL_SOURCES: SessionSource[] = ['claude', 'copilot', 'gemini', 'codex', 'opencode', 'droid', 'cursor'];

const parsers: Record<SessionSource, () => Promise<UnifiedSession[]>> = {
  claude: parseClaudeSessions,
  copilot: parseCopilotSessions,
  gemini: parseGeminiSessions,
  codex: parseCodexSessions,
  opencode: parseOpenCodeSessions,
  droid: parseDroidSessions,
  cursor: parseCursorSessions,
};

const extractors: Record<SessionSource, (s: UnifiedSession) => Promise<SessionContext>> = {
  claude: extractClaudeContext,
  copilot: extractCopilotContext,
  gemini: extractGeminiContext,
  codex: extractCodexContext,
  opencode: extractOpenCodeContext,
  droid: extractDroidContext,
  cursor: extractCursorContext,
};

// Results directory
const RESULTS_DIR = path.join(process.env.HOME || '~', '.continues', 'e2e-test-results');

// Pre-extracted contexts from real sessions
const contexts: Record<string, SessionContext> = {};
const handoffFiles: Record<string, string> = {};

/**
 * Check if a CLI tool is available
 */
function toolExists(tool: string): boolean {
  try {
    execSync(`which ${tool}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the prompt that asks the target tool to confirm it understands the context
 */
function buildVerificationPrompt(handoffMarkdown: string, sourceLabel: string): string {
  return `${handoffMarkdown}

---
IMPORTANT: You are receiving a session handoff from ${sourceLabel}. 
To verify you received the context correctly, respond with EXACTLY this format:
1. Start with "HANDOFF_RECEIVED"
2. State what the original session was about in ONE sentence
3. State the source tool name

Keep your response under 200 words. Do NOT use any tools, do NOT modify any files. Just acknowledge.`;
}

/**
 * Run a CLI tool with a prompt and capture output (non-interactive)
 */
function runTool(tool: SessionSource, prompt: string, cwd: string): string {
  const tmpFile = path.join(RESULTS_DIR, `prompt-${tool}-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, prompt);

  try {
    let cmd: string;
    const timeout = 120_000; // 2 min timeout

    switch (tool) {
      case 'claude':
        cmd = `claude -p --max-turns 1 < "${tmpFile}"`;
        break;
      case 'gemini':
        cmd = `gemini -p < "${tmpFile}"`;
        break;
      case 'codex':
        cmd = `codex exec --approval-mode full-auto -q < "${tmpFile}"`;
        break;
      case 'opencode':
        cmd = `cat "${tmpFile}" | opencode run`;
        break;
      case 'copilot':
        // Copilot doesn't have a clean print mode; use -i with stdin
        cmd = `cat "${tmpFile}" | copilot -i "$(cat ${tmpFile} | head -c 4000)" --no-ask-user 2>&1 | head -100`;
        break;
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }

    const output = execSync(cmd, {
      cwd,
      timeout,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    return output.trim();
  } catch (err: any) {
    return `ERROR: ${err.message?.slice(0, 500) || 'unknown error'}`;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

beforeAll(async () => {
  // Ensure results directory exists
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Extract context from the smallest real session of each source
  for (const source of ALL_SOURCES) {
    try {
      const sessions = await parsers[source]();
      if (sessions.length === 0) {
        console.log(`⚠ No ${source} sessions found, skipping`);
        continue;
      }

      // Pick smallest session with actual content
      const sorted = [...sessions].sort((a, b) => a.bytes - b.bytes);
      const session = sorted.find((s) => s.bytes > 200) || sessions[sessions.length - 1];

      const ctx = await extractors[source](session);
      if (ctx.recentMessages.length === 0) {
        // Try next session
        for (const s of sessions.slice(0, 5)) {
          const c = await extractors[source](s);
          if (c.recentMessages.length > 0) {
            contexts[source] = c;
            break;
          }
        }
      } else {
        contexts[source] = ctx;
      }

      if (contexts[source]) {
        // Save handoff markdown to file
        const mdPath = path.join(RESULTS_DIR, `handoff-from-${source}.md`);
        fs.writeFileSync(mdPath, contexts[source].markdown);
        handoffFiles[source] = mdPath;
        console.log(
          `✓ ${source}: extracted ${contexts[source].recentMessages.length} messages from session ${session.id.slice(0, 12)}`,
        );
      }
    } catch (err) {
      console.log(`⚠ ${source}: extraction failed - ${err}`);
    }
  }
}, 60_000);

// ─── Test: handoff markdowns were extracted from all 5 sources ──────────────

describe('E2E: Handoff Markdown Extraction', () => {
  for (const source of ALL_SOURCES) {
    it(`${source}: handoff markdown extracted from real session`, () => {
      expect(contexts[source], `No context for ${source}`).toBeDefined();
      expect(contexts[source].markdown.length).toBeGreaterThan(100);
      expect(contexts[source].recentMessages.length).toBeGreaterThan(0);

      // Markdown file was saved
      expect(handoffFiles[source]).toBeTruthy();
      expect(fs.existsSync(handoffFiles[source])).toBe(true);
    });
  }
});

// ─── Test: All 20 conversion paths via live CLI injection ──────────────────

describe('E2E: 20 Cross-Tool Conversion Paths', () => {
  let convNum = 0;

  for (const source of ALL_SOURCES) {
    for (const target of ALL_SOURCES) {
      if (source === target) continue;
      convNum++;

      it(`#${convNum}: ${source} → ${target}`, async () => {
        // Skip if source context wasn't extracted
        if (!contexts[source]) {
          console.log(`  ⚠ Skipping: no ${source} context`);
          return;
        }

        // Skip if target tool not installed
        if (!toolExists(target)) {
          console.log(`  ⚠ Skipping: ${target} not installed`);
          return;
        }

        const sourceLabels: Record<SessionSource, string> = {
          claude: 'Claude Code',
          copilot: 'GitHub Copilot CLI',
          gemini: 'Gemini CLI',
          codex: 'Codex CLI',
          opencode: 'OpenCode',
          droid: 'Factory Droid',
          cursor: 'Cursor AI',
        };
        const sourceLabel = sourceLabels[source];

        const prompt = buildVerificationPrompt(contexts[source].markdown, sourceLabel);
        const cwd = contexts[source].session.cwd || process.cwd();

        console.log(`  Running: ${source} → ${target} (cwd: ${cwd})`);
        const output = runTool(target, prompt, cwd);

        // Save result
        const resultFile = path.join(RESULTS_DIR, `result-${source}-to-${target}.txt`);
        fs.writeFileSync(resultFile, output);

        // Validate the target tool responded (not an error)
        expect(output.length, `${target} produced empty output`).toBeGreaterThan(0);
        expect(output).not.toMatch(/^ERROR: Command failed/);

        // The target should acknowledge the handoff
        // (LLMs should respond with HANDOFF_RECEIVED or reference the original context)
        const lowerOutput = output.toLowerCase();
        const acknowledged =
          lowerOutput.includes('handoff') ||
          lowerOutput.includes('session') ||
          lowerOutput.includes('context') ||
          lowerOutput.includes('previous') ||
          lowerOutput.includes('continue') ||
          lowerOutput.includes('received') ||
          output.includes('HANDOFF_RECEIVED');

        expect(
          acknowledged,
          `${target} did not acknowledge the handoff from ${source}. Output: ${output.slice(0, 300)}`,
        ).toBe(true);
      }, 180_000); // 3 min timeout per test
    }
  }
});

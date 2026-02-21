#!/usr/bin/env tsx
/**
 * Comprehensive Stress Test for Session Parsers
 *
 * This script validates all 5 parsers against real large sessions on this machine:
 * - Parses the largest real sessions for each format
 * - Validates extracted data structure
 * - Cross-converts between all formats (5 sources × 4 targets = 20 conversions)
 * - Reports timing and results
 *
 * Run with: npx tsx src/__tests__/stress-test.ts
 */

import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { extractClaudeContext } from '../parsers/claude.js';
import { extractCodexContext } from '../parsers/codex.js';
import { extractCopilotContext } from '../parsers/copilot.js';
import { extractGeminiContext } from '../parsers/gemini.js';
import { extractOpenCodeContext } from '../parsers/opencode.js';
import type { SessionContext, UnifiedSession } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';

// ============================================================================
// TEST SESSION CONFIGURATIONS
// ============================================================================

interface TestSession {
  name: string;
  source: 'claude' | 'copilot' | 'gemini' | 'codex' | 'opencode';
  path: string;
  expectedSize: string;
  isDirectory?: boolean;
}

const TEST_SESSIONS: TestSession[] = [
  // Claude Sessions (JSONL files)
  {
    name: 'Claude Large (74MB)',
    source: 'claude',
    path: '/Users/yigitkonur/.claude/projects/-Users-yigitkonur-dev-my-zeo-works-zeo-nextjs/28aa7039-299a-4cbe-aca6-58aa4bf68f25.jsonl',
    expectedSize: '~74MB',
  },
  {
    name: 'Claude Medium (52MB)',
    source: 'claude',
    path: '/Users/yigitkonur/.claude/projects/-Users-yigitkonur-dev-my-experiments/ee128819-496f-4b8b-8118-096d5e0f9075.jsonl',
    expectedSize: '~52MB',
  },

  // Copilot Sessions (directories with events.jsonl)
  {
    name: 'Copilot Large (7MB)',
    source: 'copilot',
    path: '/Users/yigitkonur/.copilot/session-state/a076b8ae-2ea2-4a94-9985-f8984747cf69',
    expectedSize: '~7MB',
    isDirectory: true,
  },
  {
    name: 'Copilot Medium',
    source: 'copilot',
    path: '/Users/yigitkonur/.copilot/session-state/ff2a067f-7403-4f27-afe0-bce474b709cc',
    expectedSize: '~5MB',
    isDirectory: true,
  },

  // Gemini Sessions (JSON files)
  {
    name: 'Gemini Large (67KB)',
    source: 'gemini',
    path: '/Users/yigitkonur/.gemini/tmp/9854c993ab082aff5e756625081dab4fce9678cd95c0643c1932cd3fced04560/chats/session-2026-01-31T06-50-5da5e79b.json',
    expectedSize: '~67KB',
  },
  {
    name: 'Gemini Medium',
    source: 'gemini',
    path: '/Users/yigitkonur/.gemini/tmp/cli-continues/chats/session-2026-02-19T00-55-4c7f6d40.json',
    expectedSize: '~40KB',
  },

  // Codex Sessions (JSONL files)
  {
    name: 'Codex Large (12MB)',
    source: 'codex',
    path: '/Users/yigitkonur/.codex/sessions/2026/02/11/rollout-2026-02-11T13-33-08-019c4e9f-4a9f-7091-98a0-1f0bc6894c10.jsonl',
    expectedSize: '~12MB',
  },
  {
    name: 'Codex Medium (8MB)',
    source: 'codex',
    path: '/Users/yigitkonur/.codex/sessions/2026/02/17/rollout-2026-02-17T16-44-56-019c6e35-0c75-7e13-a35d-c5aee1134efe.jsonl',
    expectedSize: '~8MB',
  },

  // OpenCode Session (SQLite database)
  {
    name: 'OpenCode (SQLite ~2MB)',
    source: 'opencode',
    path: '/Users/yigitkonur/.local/share/opencode/opencode.db',
    expectedSize: '~2MB',
  },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/** Format bytes to human-readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
}

/** Format duration in milliseconds */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Get current memory usage in MB */
function getMemoryUsageMB(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed / 1024 / 1024;
}

/** Format memory size */
function formatMemory(mb: number): string {
  return `${mb.toFixed(2)} MB`;
}

/** Check if path exists */
function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** Get file/directory size */
function getPathSize(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    if (stats.isFile()) {
      return stats.size;
    } else if (stats.isDirectory()) {
      // For directories, get events.jsonl size (for Copilot)
      const eventsPath = path.join(filePath, 'events.jsonl');
      if (fs.existsSync(eventsPath)) {
        return fs.statSync(eventsPath).size;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Create a UnifiedSession from a file path */
function createSessionFromPath(testSession: TestSession): UnifiedSession | null {
  const { name, source, path: filePath } = testSession;

  if (!pathExists(filePath)) {
    console.error(`  ❌ Path not found: ${filePath}`);
    return null;
  }

  const size = getPathSize(filePath);
  const stats = fs.statSync(filePath);

  // Extract session ID from path
  let sessionId: string;
  if (source === 'claude' || source === 'codex') {
    sessionId = path.basename(filePath, '.jsonl').split('-').slice(-5).join('-');
  } else if (source === 'copilot') {
    sessionId = path.basename(filePath);
  } else if (source === 'gemini') {
    sessionId = path.basename(filePath, '.json').replace('session-', '');
  } else if (source === 'opencode') {
    // Query the OpenCode DB to find the session with the most messages
    try {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = path.join(process.env.HOME || '~', '.local', 'share', 'opencode', 'opencode.db');
      const db = new DatabaseSync(dbPath, { open: true, readOnly: true });

      // Find session with most messages
      const result = db
        .prepare('SELECT m.session_id, COUNT(*) as cnt FROM message m GROUP BY m.session_id ORDER BY cnt DESC LIMIT 1')
        .get() as { session_id: string; cnt: number } | undefined;

      if (result) {
        sessionId = result.session_id;

        // Get session details for cwd
        const sessionRow = db.prepare('SELECT id, title, directory FROM session WHERE id = ?').get(result.session_id) as
          | { id: string; title?: string; directory?: string }
          | undefined;

        if (sessionRow?.directory) {
          // Store directory for later use in the return statement
          (testSession as any)._opencodeDir = sessionRow.directory;
        }
      } else {
        sessionId = 'latest';
      }

      db.close();
    } catch (err) {
      console.error(`  ⚠️  Failed to query OpenCode DB: ${err}`);
      sessionId = 'latest';
    }
  } else {
    sessionId = 'unknown';
  }

  return {
    id: sessionId,
    source,
    cwd:
      source === 'copilot'
        ? filePath
        : source === 'opencode' && (testSession as any)._opencodeDir
          ? (testSession as any)._opencodeDir
          : path.dirname(filePath),
    repo: 'test-repo',
    lines: 0,
    bytes: size,
    createdAt: stats.birthtime || stats.mtime,
    updatedAt: stats.mtime,
    originalPath: filePath,
    summary: name,
  };
}

/** Validate SessionContext structure */
function validateContext(context: SessionContext, sourceName: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required fields
  if (!context.session) errors.push('Missing session');
  if (!context.recentMessages) errors.push('Missing recentMessages');
  if (!Array.isArray(context.recentMessages)) errors.push('recentMessages is not an array');
  if (!context.markdown) errors.push('Missing markdown');

  // Check filesModified and pendingTasks exist
  if (!Array.isArray(context.filesModified)) errors.push('filesModified is not an array');
  if (!Array.isArray(context.pendingTasks)) errors.push('pendingTasks is not an array');

  // Check message structure
  if (context.recentMessages) {
    context.recentMessages.forEach((msg, idx) => {
      if (!msg.role) errors.push(`Message ${idx}: missing role`);
      if (msg.content === undefined || msg.content === null) {
        errors.push(`Message ${idx}: missing content`);
      }
      if (!['user', 'assistant', 'system', 'tool'].includes(msg.role)) {
        errors.push(`Message ${idx}: invalid role '${msg.role}'`);
      }
      // Validate content is a string
      if (typeof msg.content !== 'string') {
        errors.push(`Message ${idx}: content is not a string (got ${typeof msg.content})`);
      }
    });
  }

  // Check markdown structure
  if (context.markdown) {
    const requiredSections = ['# Session Handoff Context', '## Recent Conversation'];
    for (const section of requiredSections) {
      if (!context.markdown.includes(section)) {
        errors.push(`Markdown missing section: ${section}`);
      }
    }

    // Check that markdown is not too small (should have real content)
    if (context.markdown.length < 100) {
      errors.push(`Markdown too short (${context.markdown.length} chars) - may be missing content`);
    }
  }

  // Check session metadata
  if (context.session) {
    if (!context.session.id) errors.push('Session missing id');
    if (!context.session.source) errors.push('Session missing source');
    if (!context.session.originalPath) errors.push('Session missing originalPath');
  }

  return { valid: errors.length === 0, errors };
}

/** Validate cross-conversion (recreate markdown for different target) */
function validateCrossConversion(
  sourceContext: SessionContext,
  targetSource: 'claude' | 'copilot' | 'gemini' | 'codex' | 'opencode',
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    // Create a new session object as if it came from the target source
    const targetSession: UnifiedSession = {
      ...sourceContext.session,
      source: targetSource,
    };

    // Generate markdown using the target source
    const markdown = generateHandoffMarkdown(
      targetSession,
      sourceContext.recentMessages,
      sourceContext.filesModified,
      sourceContext.pendingTasks,
    );

    // Validate the generated markdown
    if (!markdown) errors.push('Generated markdown is empty');
    if (markdown && !markdown.includes('# Session Handoff Context')) {
      errors.push('Markdown missing main header');
    }
    if (markdown && !markdown.includes('## Recent Conversation')) {
      errors.push('Markdown missing conversation section');
    }
  } catch (error) {
    errors.push(`Cross-conversion error: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// EXTRACTION FUNCTIONS
// ============================================================================

type ExtractFunction = (session: UnifiedSession) => Promise<SessionContext>;

const EXTRACTORS: Record<string, ExtractFunction> = {
  claude: extractClaudeContext,
  copilot: extractCopilotContext,
  gemini: extractGeminiContext,
  codex: extractCodexContext,
  opencode: extractOpenCodeContext,
};

// ============================================================================
// TEST RESULTS TRACKING
// ============================================================================

interface TestResult {
  session: string;
  source: string;
  status: 'pass' | 'fail' | 'skip';
  duration: number;
  messageCount: number;
  markdownLength: number;
  errors: string[];
  memoryUsedMB?: number;
}

interface ConversionResult {
  from: string;
  to: string;
  status: 'pass' | 'fail' | 'skip';
  errors: string[];
}

const testResults: TestResult[] = [];
const conversionResults: ConversionResult[] = [];

// ============================================================================
// MAIN TEST EXECUTION
// ============================================================================

async function runStressTest() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║        SESSION PARSER COMPREHENSIVE STRESS TEST                ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log();

  // Phase 1: Test each parser with its real sessions
  console.log('📊 PHASE 1: PARSING & EXTRACTION TESTS');
  console.log('─'.repeat(70));
  console.log();

  const extractedContexts: Map<string, SessionContext> = new Map();

  for (const testSession of TEST_SESSIONS) {
    const { name, source, path: filePath } = testSession;

    console.log(`Testing: ${name}`);
    console.log(`  Source: ${source}`);
    console.log(`  Path: ${filePath}`);

    // Check if path exists
    if (!pathExists(filePath)) {
      console.log(`  ⚠️  SKIP - Path not found`);
      testResults.push({
        session: name,
        source,
        status: 'skip',
        duration: 0,
        messageCount: 0,
        markdownLength: 0,
        errors: ['Path not found'],
      });
      console.log();
      continue;
    }

    const size = getPathSize(filePath);
    console.log(`  Size: ${formatBytes(size)}`);

    // Create session object
    const session = createSessionFromPath(testSession);
    if (!session) {
      console.log(`  ❌ FAIL - Could not create session object`);
      testResults.push({
        session: name,
        source,
        status: 'fail',
        duration: 0,
        messageCount: 0,
        markdownLength: 0,
        errors: ['Failed to create session object'],
      });
      console.log();
      continue;
    }

    // Extract context
    const startTime = performance.now();
    const memBefore = getMemoryUsageMB();
    try {
      const extractor = EXTRACTORS[source];
      const context = await extractor(session);
      const duration = performance.now() - startTime;
      const memAfter = getMemoryUsageMB();
      const memUsed = memAfter - memBefore;

      // Validate context
      const validation = validateContext(context, name);

      if (validation.valid) {
        console.log(`  ✅ PASS - Extracted in ${formatDuration(duration)}`);
        console.log(`     Messages: ${context.recentMessages.length}`);
        console.log(
          `     Markdown: ${formatBytes(context.markdown.length)} (${context.markdown.split('\n').length} lines)`,
        );
        console.log(`     Working Dir: ${context.session.cwd}`);
        console.log(`     Memory Used: ${formatMemory(memUsed)}`);

        testResults.push({
          session: name,
          source,
          status: 'pass',
          duration,
          messageCount: context.recentMessages.length,
          markdownLength: context.markdown.length,
          errors: [],
          memoryUsedMB: memUsed,
        });

        // Store for cross-conversion tests
        extractedContexts.set(name, context);
      } else {
        console.log(`  ❌ FAIL - Validation errors:`);
        for (const err of validation.errors) console.log(`     - ${err}`);

        testResults.push({
          session: name,
          source,
          status: 'fail',
          duration,
          messageCount: context.recentMessages?.length || 0,
          markdownLength: context.markdown?.length || 0,
          errors: validation.errors,
        });
      }
    } catch (error) {
      const duration = performance.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`  ❌ FAIL - ${errorMsg}`);

      testResults.push({
        session: name,
        source,
        status: 'fail',
        duration,
        messageCount: 0,
        markdownLength: 0,
        errors: [errorMsg],
      });
    }

    console.log();
  }

  // Phase 2: Cross-conversion tests
  console.log('🔄 PHASE 2: CROSS-CONVERSION TESTS');
  console.log('─'.repeat(70));
  console.log();
  console.log('Testing all 20 conversion paths (5 sources × 4 targets each)...');
  console.log();

  const sources: Array<'claude' | 'copilot' | 'gemini' | 'codex' | 'opencode'> = [
    'claude',
    'copilot',
    'gemini',
    'codex',
    'opencode',
  ];

  // Take one successful extraction from each source
  const sourceContexts = new Map<string, SessionContext>();
  for (const source of sources) {
    const context = Array.from(extractedContexts.entries()).find(([name, ctx]) => ctx.session.source === source)?.[1];
    if (context) {
      sourceContexts.set(source, context);
    }
  }

  console.log(`Found ${sourceContexts.size} source contexts to test conversions`);
  console.log();

  for (const sourceType of sources) {
    const sourceContext = sourceContexts.get(sourceType);
    if (!sourceContext) {
      // Mark all conversions from this source as skip
      for (const targetType of sources) {
        if (sourceType !== targetType) {
          conversionResults.push({
            from: sourceType,
            to: targetType,
            status: 'skip',
            errors: ['No source context available'],
          });
        }
      }
      continue;
    }

    console.log(`From ${sourceType.toUpperCase()}:`);

    for (const targetType of sources) {
      if (sourceType === targetType) continue; // Skip same-to-same

      const validation = validateCrossConversion(sourceContext, targetType);

      if (validation.valid) {
        console.log(`  ✅ ${sourceType} → ${targetType}`);
        conversionResults.push({
          from: sourceType,
          to: targetType,
          status: 'pass',
          errors: [],
        });
      } else {
        console.log(`  ❌ ${sourceType} → ${targetType}`);
        for (const err of validation.errors) console.log(`     - ${err}`);
        conversionResults.push({
          from: sourceType,
          to: targetType,
          status: 'fail',
          errors: validation.errors,
        });
      }
    }
    console.log();
  }

  // Phase 3: Summary Report
  console.log('📈 SUMMARY REPORT');
  console.log('═'.repeat(70));
  console.log();

  // Extraction Tests Summary
  console.log('Extraction Tests:');
  console.log('─'.repeat(70));
  const passed = testResults.filter((r) => r.status === 'pass').length;
  const failed = testResults.filter((r) => r.status === 'fail').length;
  const skipped = testResults.filter((r) => r.status === 'skip').length;
  const total = testResults.length;

  console.log(`Total: ${total} | ✅ Pass: ${passed} | ❌ Fail: ${failed} | ⚠️  Skip: ${skipped}`);
  console.log();

  // Detailed results table
  console.log('Session                      | Source   | Status | Time     | Msgs | MD Size');
  console.log('─'.repeat(70));
  for (const result of testResults) {
    const statusIcon = result.status === 'pass' ? '✅' : result.status === 'fail' ? '❌' : '⚠️';
    const sessionName = result.session.padEnd(28);
    const source = result.source.padEnd(8);
    const status = statusIcon;
    const time = formatDuration(result.duration).padStart(8);
    const msgs = String(result.messageCount).padStart(4);
    const mdSize = formatBytes(result.markdownLength).padStart(7);

    console.log(`${sessionName} | ${source} | ${status} | ${time} | ${msgs} | ${mdSize}`);
  }
  console.log();

  // Cross-Conversion Summary
  console.log('Cross-Conversion Tests (5 sources × 4 targets = 20 paths):');
  console.log('─'.repeat(70));
  const convPassed = conversionResults.filter((r) => r.status === 'pass').length;
  const convFailed = conversionResults.filter((r) => r.status === 'fail').length;
  const convSkipped = conversionResults.filter((r) => r.status === 'skip').length;
  const convTotal = conversionResults.length;

  console.log(`Total: ${convTotal} | ✅ Pass: ${convPassed} | ❌ Fail: ${convFailed} | ⚠️  Skip: ${convSkipped}`);
  console.log();

  // Conversion matrix
  console.log('Conversion Matrix (✅ = pass, ❌ = fail, ⚠️  = skip):');
  console.log();
  console.log('        │ claude │ copilot │ gemini │ codex │ opencode');
  console.log('────────┼────────┼─────────┼────────┼───────┼─────────');

  for (const fromSource of sources) {
    const row = [`${fromSource.padEnd(7)} │`];
    for (const toSource of sources) {
      if (fromSource === toSource) {
        row.push('   -   │');
      } else {
        const result = conversionResults.find((r) => r.from === fromSource && r.to === toSource);
        const icon = result?.status === 'pass' ? '  ✅   ' : result?.status === 'fail' ? '  ❌   ' : '  ⚠️    ';
        row.push(`${icon}│`);
      }
    }
    console.log(row.join(' '));
  }
  console.log();

  // Performance Stats
  const successfulTests = testResults.filter((r) => r.status === 'pass');
  if (successfulTests.length > 0) {
    console.log('Performance Statistics:');
    console.log('─'.repeat(70));

    const avgDuration = successfulTests.reduce((sum, r) => sum + r.duration, 0) / successfulTests.length;
    const maxDuration = Math.max(...successfulTests.map((r) => r.duration));
    const minDuration = Math.min(...successfulTests.map((r) => r.duration));

    console.log(`Average Parse Time: ${formatDuration(avgDuration)}`);
    console.log(`Fastest: ${formatDuration(minDuration)}`);
    console.log(`Slowest: ${formatDuration(maxDuration)}`);

    // Memory stats
    const testsWithMemory = successfulTests.filter((r) => r.memoryUsedMB !== undefined);
    if (testsWithMemory.length > 0) {
      const avgMemory = testsWithMemory.reduce((sum, r) => sum + (r.memoryUsedMB || 0), 0) / testsWithMemory.length;
      const maxMemory = Math.max(...testsWithMemory.map((r) => r.memoryUsedMB || 0));
      console.log(`Average Memory Used: ${formatMemory(avgMemory)}`);
      console.log(`Peak Memory: ${formatMemory(maxMemory)}`);
    }

    // Show largest session parsed
    const largestSession = successfulTests.reduce((max, r) =>
      testResults.find((t) => t.session === r.session && t.status === 'pass') &&
      TEST_SESSIONS.find((s) => s.name === r.session)!.expectedSize >
        TEST_SESSIONS.find((s) => s.name === max.session)!.expectedSize
        ? r
        : max,
    );

    console.log(`Largest Session Tested: ${largestSession.session} (${formatDuration(largestSession.duration)})`);

    // Throughput calculation
    const totalBytes = successfulTests.reduce((sum, r) => {
      const ts = TEST_SESSIONS.find((s) => s.name === r.session);
      return sum + (ts ? getPathSize(ts.path) : 0);
    }, 0);
    const totalTime = successfulTests.reduce((sum, r) => sum + r.duration, 0);
    if (totalTime > 0) {
      const mbPerSecond = totalBytes / 1024 / 1024 / (totalTime / 1000);
      console.log(`Overall Throughput: ${mbPerSecond.toFixed(2)} MB/s`);
    }

    console.log();
  }

  // Final verdict
  console.log('═'.repeat(70));
  const allPassed = failed === 0 && convFailed === 0;
  if (allPassed) {
    console.log('🎉 ALL TESTS PASSED!');
  } else {
    console.log(`⚠️  TESTS COMPLETED WITH ${failed + convFailed} FAILURES`);
  }
  console.log('═'.repeat(70));

  // Exit with appropriate code
  process.exit(allPassed ? 0 : 1);
}

// Run the stress test
runStressTest().catch((error) => {
  console.error('Fatal error running stress test:', error);
  process.exit(1);
});

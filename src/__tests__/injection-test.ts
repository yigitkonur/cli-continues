#!/usr/bin/env npx tsx
/**
 * Injection Round-Trip Validation
 *
 * For each of 5 sources × 4 targets (20 paths total):
 *  1. Create a synthetic source session with a unique key phrase
 *  2. Extract context using the source parser
 *  3. Write the handoff markdown in the target format
 *  4. Read it back using the target parser
 *  5. Verify the key phrase survives the round-trip
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractClaudeContext } from '../parsers/claude.js';
import { extractCodexContext } from '../parsers/codex.js';
import { extractCopilotContext } from '../parsers/copilot.js';
import { extractGeminiContext } from '../parsers/gemini.js';
import type { ConversationMessage, SessionContext, UnifiedSession } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCES = ['claude', 'copilot', 'gemini', 'codex', 'opencode'] as const;
type Source = (typeof SOURCES)[number];

const KEY_PHRASES: Record<Source, string> = {
  claude: 'CLAUDE_ROUNDTRIP_MARKER_7f3a',
  copilot: 'COPILOT_ROUNDTRIP_MARKER_8b2c',
  gemini: 'GEMINI_ROUNDTRIP_MARKER_9d4e',
  codex: 'CODEX_ROUNDTRIP_MARKER_a1f5',
  opencode: 'OPENCODE_ROUNDTRIP_MARKER_b6c7',
};

const TEMP_DIR = path.join(os.tmpdir(), `injection-test-${Date.now()}`);

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

interface TestResult {
  source: Source;
  target: Source;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let pathCounter = 0;
function uniqueSuffix(): string {
  return String(++pathCounter);
}

function makeSession(source: Source, originalPath: string): UnifiedSession {
  return {
    id: `test-${source}-session`,
    source,
    cwd: '/tmp/test-project',
    repo: 'test-owner/test-repo',
    branch: 'main',
    summary: `Test session from ${source}`,
    lines: 10,
    bytes: 1000,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    originalPath,
  };
}

// ---------------------------------------------------------------------------
// Create synthetic SOURCE sessions
// ---------------------------------------------------------------------------

function createClaudeSource(): string {
  const filePath = path.join(TEMP_DIR, 'sources', 'claude-session.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-01-01T00:00:00Z',
      sessionId: 'test-claude-session',
      cwd: '/tmp/test-project',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Please implement the ${KEY_PHRASES.claude} feature` }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-01-01T00:01:00Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Sure, I will implement that feature for you right away.' }],
      },
    }),
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

function createCopilotSource(): string {
  const dirPath = path.join(TEMP_DIR, 'sources', 'copilot-session');
  fs.mkdirSync(dirPath, { recursive: true });

  fs.writeFileSync(
    path.join(dirPath, 'workspace.yaml'),
    [
      'id: test-copilot-session',
      'cwd: /tmp/test-project',
      'summary: "Test copilot session"',
      'created_at: "2026-01-01T00:00:00Z"',
      'updated_at: "2026-01-02T00:00:00Z"',
    ].join('\n'),
  );

  const events = [
    JSON.stringify({
      type: 'user.message',
      id: 'e1',
      timestamp: '2026-01-01T00:00:00Z',
      data: { content: `Please implement the ${KEY_PHRASES.copilot} feature` },
    }),
    JSON.stringify({
      type: 'assistant.message',
      id: 'e2',
      timestamp: '2026-01-01T00:01:00Z',
      data: { content: 'Sure, I will implement that feature for you right away.', toolRequests: [] },
    }),
  ];

  fs.writeFileSync(path.join(dirPath, 'events.jsonl'), events.join('\n') + '\n');
  return dirPath;
}

function createGeminiSource(): string {
  const filePath = path.join(TEMP_DIR, 'sources', 'gemini-session.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const session = {
    sessionId: 'test-gemini-session',
    projectHash: 'abc123',
    startTime: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-02T00:00:00Z',
    messages: [
      {
        id: 'm1',
        timestamp: '2026-01-01T00:00:00Z',
        type: 'user',
        content: `Please implement the ${KEY_PHRASES.gemini} feature`,
      },
      {
        id: 'm2',
        timestamp: '2026-01-01T00:01:00Z',
        type: 'gemini',
        content: 'Sure, I will implement that feature for you right away.',
      },
    ],
  };

  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

function createCodexSource(): string {
  const filePath = path.join(TEMP_DIR, 'sources', 'codex-session.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const lines = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { id: 'test-codex-session', cwd: '/tmp/test-project' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { type: 'user_message', message: `Please implement the ${KEY_PHRASES.codex} feature` },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-01-01T00:01:00Z',
      payload: { type: 'agent_message', message: 'Sure, I will implement that feature for you right away.' },
    }),
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

// ---------------------------------------------------------------------------
// Extract source context (OpenCode uses mock since it has hardcoded paths)
// ---------------------------------------------------------------------------

async function extractSourceContext(source: Source): Promise<SessionContext> {
  if (source === 'opencode') {
    const session = makeSession('opencode', '/tmp/fake-opencode-path');
    const messages: ConversationMessage[] = [
      {
        role: 'user',
        content: `Please implement the ${KEY_PHRASES.opencode} feature`,
        timestamp: new Date('2026-01-01T00:00:00Z'),
      },
      {
        role: 'assistant',
        content: 'Sure, I will implement that feature for you right away.',
        timestamp: new Date('2026-01-01T00:01:00Z'),
      },
    ];
    const markdown = generateHandoffMarkdown(session, messages, [], [], []);
    return { session, recentMessages: messages, filesModified: [], pendingTasks: [], toolSummaries: [], markdown };
  }

  let originalPath: string;
  let session: UnifiedSession;

  switch (source) {
    case 'claude':
      originalPath = createClaudeSource();
      session = makeSession('claude', originalPath);
      return extractClaudeContext(session);
    case 'copilot':
      originalPath = createCopilotSource();
      session = makeSession('copilot', originalPath);
      return extractCopilotContext(session);
    case 'gemini':
      originalPath = createGeminiSource();
      session = makeSession('gemini', originalPath);
      return extractGeminiContext(session);
    case 'codex':
      originalPath = createCodexSource();
      session = makeSession('codex', originalPath);
      return extractCodexContext(session);
    default:
      throw new Error(`Unknown source: ${source}`);
  }
}

// ---------------------------------------------------------------------------
// Write TARGET format files
// ---------------------------------------------------------------------------

function writeClaudeTarget(markdown: string, label: string): string {
  const filePath = path.join(TEMP_DIR, 'targets', `claude-${label}-${uniqueSuffix()}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'inject-u1',
      timestamp: '2026-02-19T00:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: markdown }] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'inject-a1',
      timestamp: '2026-02-19T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Got it, I have the context.' }] },
    }),
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

function writeCopilotTarget(markdown: string, label: string): string {
  const dirPath = path.join(TEMP_DIR, 'targets', `copilot-${label}-${uniqueSuffix()}`);
  fs.mkdirSync(dirPath, { recursive: true });

  fs.writeFileSync(
    path.join(dirPath, 'workspace.yaml'),
    [
      'id: test-inject',
      'cwd: /tmp',
      'summary: "Injected session"',
      'created_at: "2026-02-19T00:00:00Z"',
      'updated_at: "2026-02-19T00:00:01Z"',
    ].join('\n'),
  );

  const events = [
    JSON.stringify({
      type: 'user.message',
      id: 'inject-e1',
      timestamp: '2026-02-19T00:00:00Z',
      data: { content: markdown },
    }),
    JSON.stringify({
      type: 'assistant.message',
      id: 'inject-e2',
      timestamp: '2026-02-19T00:00:01Z',
      data: { content: 'Got it, I have the context.', toolRequests: [] },
    }),
  ];

  fs.writeFileSync(path.join(dirPath, 'events.jsonl'), events.join('\n') + '\n');
  return dirPath;
}

function writeGeminiTarget(markdown: string, label: string): string {
  const filePath = path.join(TEMP_DIR, 'targets', `gemini-${label}-${uniqueSuffix()}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const session = {
    sessionId: 'test-inject',
    projectHash: 'inject-hash',
    startTime: '2026-02-19T00:00:00Z',
    lastUpdated: '2026-02-19T00:00:01Z',
    messages: [
      { id: 'inject-m1', timestamp: '2026-02-19T00:00:00Z', type: 'user', content: markdown },
      { id: 'inject-m2', timestamp: '2026-02-19T00:00:01Z', type: 'gemini', content: 'I have the context.' },
    ],
  };

  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

function writeCodexTarget(markdown: string, label: string): string {
  const filePath = path.join(TEMP_DIR, 'targets', `codex-${label}-${uniqueSuffix()}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const lines = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-02-19T00:00:00Z',
      payload: { id: 'test-inject', cwd: '/tmp' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-02-19T00:00:00Z',
      payload: { type: 'user_message', message: markdown },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-02-19T00:00:01Z',
      payload: { type: 'agent_message', message: 'Got it, I have the context.' },
    }),
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

function writeOpenCodeTarget(markdown: string, label: string): string {
  // OpenCode uses a hardcoded SQLite path — write a JSON representation to verify
  // content serialization, and skip the parser read-back.
  const filePath = path.join(TEMP_DIR, 'targets', `opencode-${label}-${uniqueSuffix()}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const data = {
    session: { id: 'test-inject', directory: '/tmp', time: { created: Date.now(), updated: Date.now() } },
    messages: [
      { role: 'user', content: markdown },
      { role: 'assistant', content: 'Got it, I have the context.' },
    ],
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Read back from target
// ---------------------------------------------------------------------------

async function readBackFromTarget(target: Source, targetPath: string): Promise<SessionContext> {
  const session = makeSession(target, targetPath);

  switch (target) {
    case 'claude':
      return extractClaudeContext(session);
    case 'copilot':
      return extractCopilotContext(session);
    case 'gemini':
      return extractGeminiContext(session);
    case 'codex':
      return extractCodexContext(session);
    default:
      throw new Error(`Cannot read back from target: ${target}`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(source: Source, target: Source, keyPhrase: string, targetContext: SessionContext | null): TestResult {
  if (!targetContext) {
    return { source, target, passed: false, details: 'Failed to read back target context' };
  }

  // Check: message count > 0
  if (targetContext.recentMessages.length === 0) {
    return { source, target, passed: false, details: 'No messages extracted from target (count=0)' };
  }

  const allContent = targetContext.recentMessages.map((m) => m.content).join('\n');

  // Check: handoff markdown header present
  if (!allContent.includes('Session Handoff')) {
    return { source, target, passed: false, details: 'Handoff markdown header not found in target messages' };
  }

  // Check: key phrase from source survives round-trip
  if (!allContent.includes(keyPhrase)) {
    return {
      source,
      target,
      passed: false,
      details: `Key phrase "${keyPhrase}" missing from round-tripped content`,
    };
  }

  return {
    source,
    target,
    passed: true,
    details: `OK (${targetContext.recentMessages.length} msgs, key phrase found)`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Injection Round-Trip Validation (20 paths)    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  fs.mkdirSync(TEMP_DIR, { recursive: true });

  try {
    // ── Step 1: Extract context from every source ──────────────────────
    console.log('── Step 1: Source Extraction ──\n');
    const sourceContexts = new Map<Source, SessionContext>();

    for (const source of SOURCES) {
      process.stdout.write(`  [${source.padEnd(8)}] Extracting... `);
      try {
        const ctx = await extractSourceContext(source);
        sourceContexts.set(source, ctx);
        console.log(`✅  ${ctx.recentMessages.length} msgs, ${ctx.markdown.length} chars markdown`);
      } catch (err: any) {
        console.log(`❌  ${err.message ?? err}`);
      }
    }

    // ── Step 2: Round-trip each source → target ───────────────────────
    console.log('\n── Step 2: Round-Trip Tests ──\n');

    for (const source of SOURCES) {
      const sourceCtx = sourceContexts.get(source);
      if (!sourceCtx) {
        for (const target of SOURCES) {
          if (target === source) continue;
          results.push({ source, target, passed: false, details: 'Source extraction failed' });
          console.log(`  ${source} → ${target}: ❌ Source extraction failed`);
        }
        continue;
      }

      const keyPhrase = KEY_PHRASES[source];

      for (const target of SOURCES) {
        if (target === source) continue;

        const label = `from-${source}`;
        process.stdout.write(`  ${source.padEnd(8)} → ${target.padEnd(8)}: `);

        try {
          let targetPath: string;

          switch (target) {
            case 'claude':
              targetPath = writeClaudeTarget(sourceCtx.markdown, label);
              break;
            case 'copilot':
              targetPath = writeCopilotTarget(sourceCtx.markdown, label);
              break;
            case 'gemini':
              targetPath = writeGeminiTarget(sourceCtx.markdown, label);
              break;
            case 'codex':
              targetPath = writeCodexTarget(sourceCtx.markdown, label);
              break;
            case 'opencode':
              targetPath = writeOpenCodeTarget(sourceCtx.markdown, label);
              break;
            default:
              throw new Error(`Unknown target: ${target}`);
          }

          if (target === 'opencode') {
            // Verify file was written and contains key phrase
            const content = fs.readFileSync(targetPath, 'utf8');
            JSON.parse(content); // throws if invalid JSON
            if (content.includes(keyPhrase)) {
              const r: TestResult = {
                source,
                target,
                passed: true,
                details: 'Write OK (read-back skipped — hardcoded DB path)',
              };
              results.push(r);
              console.log(`✅ ${r.details}`);
            } else {
              const r: TestResult = {
                source,
                target,
                passed: false,
                details: `Key phrase not in written file`,
              };
              results.push(r);
              console.log(`❌ ${r.details}`);
            }
          } else {
            // Full round-trip: read back with target parser
            const targetCtx = await readBackFromTarget(target, targetPath);
            const r = validate(source, target, keyPhrase, targetCtx);
            results.push(r);
            console.log(r.passed ? `✅ ${r.details}` : `❌ ${r.details}`);
          }
        } catch (err: any) {
          const r: TestResult = {
            source,
            target,
            passed: false,
            details: `Error: ${err.message ?? err}`,
          };
          results.push(r);
          console.log(`❌ ${r.details}`);
        }
      }
    }

    // ── Step 3: Summary ───────────────────────────────────────────────
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const total = results.length;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║                  RESULTS TABLE                   ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
    console.log('Source'.padEnd(10) + '  Target'.padEnd(12) + '  Status'.padEnd(8) + '  Details');
    console.log('─'.repeat(72));

    for (const r of results) {
      const icon = r.passed ? '✅' : '❌';
      console.log(`${r.source.padEnd(10)}→ ${r.target.padEnd(10)}${icon.padEnd(6)}  ${r.details}`);
    }

    console.log('─'.repeat(72));
    console.log(`\n  ${passed}/${total} PASSED   ${failed}/${total} FAILED\n`);

    if (failed > 0) {
      console.log('❌  Some round-trip tests failed!\n');
      process.exit(1);
    } else {
      console.log('✅  All 20 round-trip tests passed!\n');
    }
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
      console.log(`Cleaned up temp dir: ${TEMP_DIR}`);
    } catch {
      console.log(`Note: could not clean up ${TEMP_DIR}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

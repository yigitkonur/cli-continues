/**
 * REAL E2E Test: cli-continues cross-tool conversion pipeline
 *
 * Tests the ACTUAL flow:
 * 1. extractContext() parses real sessions (NOT test artifacts)
 * 2. Generated markdown contains real conversation content
 * 3. Target tools receive and understand the content
 * 4. Semantic verification: target must reference specific facts from the source
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionContext, SessionSource, UnifiedSession } from '../types/index.js';
import { extractContext, getAllSessions } from '../utils/index.js';

const RESULTS_DIR = path.join(process.env.HOME!, '.continues', 'real-e2e');

interface PickedSession {
  source: string;
  session: UnifiedSession;
  context: SessionContext;
  keyFacts: string[];
}

interface TestResult {
  id: number;
  source: string;
  target: string;
  status: 'pass' | 'fail' | 'error';
  factsFound: number;
  factsTotal: number;
  factDetails: { fact: string; found: boolean }[];
  responsePreview: string;
  error?: string;
}

async function pickRealSessions(): Promise<Map<string, PickedSession>> {
  const sessions = await getAllSessions(true);
  const picked = new Map<string, PickedSession>();

  for (const source of ['claude', 'copilot', 'gemini', 'codex', 'opencode'] as const) {
    const sourceSessions = sessions.filter((s) => s.source === source);

    for (const s of sourceSessions) {
      try {
        const ctx = await extractContext(s);
        if (ctx.recentMessages.length < 2) continue;

        // Skip test artifacts from earlier runs
        const firstMsg = ctx.recentMessages[0].content;
        if (firstMsg.startsWith('# Session Handoff Context')) continue;
        if (firstMsg.includes('HANDOFF_RECEIVED')) continue;
        if (firstMsg.includes('VERIFICATION TASK')) continue;

        // Extract key facts for semantic verification
        const keyFacts = extractKeyFacts(ctx);
        if (keyFacts.length < 2) continue;

        picked.set(source, { source, session: s, context: ctx, keyFacts });
        break;
      } catch (_e) {
        /* skip sessions that fail to parse */
      }
    }
  }

  return picked;
}

function extractKeyFacts(ctx: SessionContext): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();

  // Use the summary as the primary source of key facts
  const summary = (ctx.session.summary || '').toLowerCase();

  // Also get the first user message
  const firstUser = ctx.recentMessages.find((m) => m.role === 'user');
  const firstUserContent = (firstUser?.content || '').toLowerCase();

  // All text for broader matching
  const allText = [summary, firstUserContent, ...ctx.recentMessages.map((m) => m.content)].join(' ').toLowerCase();

  // Extract SEMANTIC topic keywords (not garbage file paths)
  // Focus on words that describe WHAT the session was about
  const topicTerms =
    allText.match(
      /\b(?:ssh|quic|migration|superset|tauri|electron|authentication|codex|readme|count|sample|switcher|account|backup|architecture|remote|workspace|desktop|terminal|integration|session|handoff|picker)\b/gi,
    ) || [];

  for (const t of topicTerms) {
    const lower = t.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      facts.push(lower);
    }
  }

  // Extract meaningful file names (only short, recognizable ones)
  const files = allText.match(/\b[a-z]+\.(?:json|txt|md|ts|js|toml|db)\b/g) || [];
  for (const f of files) {
    if (f.length < 20 && !seen.has(f)) {
      seen.add(f);
      facts.push(f);
    }
  }

  // Extract short paths (only recognizable ones like ~/.codex/)
  const shortPaths = allText.match(/~\/\.[a-z]+\/[a-z.]+/g) || [];
  for (const p of shortPaths) {
    if (p.length < 30 && !seen.has(p)) {
      seen.add(p);
      facts.push(p);
    }
  }

  // Extract key action words from user message
  if (firstUserContent.length > 3) {
    const words = firstUserContent.split(/\s+/).filter((w) => w.length > 4 && /^[a-z]+$/i.test(w));
    for (const w of words.slice(0, 3)) {
      if (!seen.has(w)) {
        seen.add(w);
        facts.push(w);
      }
    }
  }

  return facts.slice(0, 8);
}

function invokeTarget(target: string, markdown: string, cwd: string): string {
  const effectiveCwd = cwd && fs.existsSync(cwd) ? cwd : process.cwd();

  const prompt = `${markdown}

---
RESPOND IN TEXT ONLY. Do NOT use any tools or run any commands.
Based ONLY on the handoff context above, describe in 2-3 sentences:
1. What was the main topic or task?
2. What specific files, tools, or technical terms were mentioned?`;

  const promptFile = path.join(RESULTS_DIR, `prompt-${target}-${Date.now()}.md`);
  fs.writeFileSync(promptFile, prompt);

  try {
    switch (target) {
      case 'claude':
        return execSync(`cat "${promptFile}" | claude -p --max-turns 2`, {
          cwd: effectiveCwd,
          timeout: 120_000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

      case 'gemini':
        return execSync(`cat "${promptFile}" | gemini -p ""`, {
          cwd: effectiveCwd,
          timeout: 120_000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

      case 'codex': {
        // Codex needs a trusted git dir
        const codexCwd = fs.existsSync(path.join(effectiveCwd, '.git')) ? effectiveCwd : process.cwd();
        return execSync(`cat "${promptFile}" | codex exec`, {
          cwd: codexCwd,
          timeout: 120_000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      }

      case 'opencode': {
        const truncated = prompt.slice(0, 4000).replace(/"/g, '\\"').replace(/`/g, '\\`');
        return execSync(`opencode run "${truncated}"`, {
          cwd: effectiveCwd,
          timeout: 120_000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: '/bin/zsh',
        }).trim();
      }

      case 'copilot': {
        const truncated = prompt.slice(0, 3000).replace(/"/g, '\\"').replace(/`/g, '\\`');
        return execSync(`timeout 90 copilot -i "${truncated}" --no-ask-user --max-autopilot-continues 0`, {
          cwd: effectiveCwd,
          timeout: 120_000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: '/bin/zsh',
        }).trim();
      }

      default:
        throw new Error(`Unknown target: ${target}`);
    }
  } catch (e: any) {
    if (e.stdout && e.stdout.length > 20) return e.stdout.toString().trim();
    throw e;
  }
}

async function main() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  REAL E2E Test: Semantic Content Preservation                 ║');
  console.log('║  Uses extractContext() on REAL sessions, verifies key facts   ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Step 1: Pick real sessions
  console.log('Step 1: Finding real sessions (skipping test artifacts)...\n');
  const picked = await pickRealSessions();

  for (const [source, data] of picked) {
    console.log(
      `  ✅ ${source}: "${data.session.summary?.slice(0, 50) || '(no summary)'}" (${data.context.recentMessages.length} msgs)`,
    );
    console.log(`     Key facts: [${data.keyFacts.join(', ')}]`);
    console.log(`     Markdown: ${data.context.markdown.length} bytes`);
  }

  if (picked.size < 5) {
    console.log(`\n  ⚠️  Only found ${picked.size}/5 sources with real sessions`);
  }

  // Step 2: Run all 20 conversions
  console.log('\n\nStep 2: Running cross-tool conversions...\n');

  const results: TestResult[] = [];
  let testId = 0;
  const targets: SessionSource[] = ['claude', 'copilot', 'gemini', 'codex', 'opencode'];

  for (const [source, sourceData] of picked) {
    console.log(`\n📤 FROM ${source.toUpperCase()}: "${sourceData.session.summary?.slice(0, 40) || '?'}"`);
    console.log(`   Facts to verify: [${sourceData.keyFacts.join(', ')}]\n`);

    for (const target of targets) {
      if (target === source) continue;
      testId++;

      console.log(`  #${testId} ${source} → ${target}...`);

      try {
        const response = invokeTarget(target, sourceData.context.markdown, sourceData.session.cwd);
        const responseLower = response.toLowerCase();

        // Verify key facts
        const factResults = sourceData.keyFacts.map((fact) => ({
          fact,
          found: responseLower.includes(fact),
        }));

        const found = factResults.filter((f) => f.found).length;
        const threshold = Math.max(1, Math.ceil(sourceData.keyFacts.length * 0.3));
        const passed = found >= threshold;

        results.push({
          id: testId,
          source,
          target,
          status: passed ? 'pass' : 'fail',
          factsFound: found,
          factsTotal: sourceData.keyFacts.length,
          factDetails: factResults,
          responsePreview: response.slice(0, 300),
        });

        const foundFacts = factResults.filter((f) => f.found).map((f) => f.fact);
        const missedFacts = factResults.filter((f) => !f.found).map((f) => f.fact);

        console.log(`     ${passed ? '✅' : '❌'} Facts: ${found}/${sourceData.keyFacts.length} (need ${threshold})`);
        if (foundFacts.length > 0) console.log(`     Found: ${foundFacts.join(', ')}`);
        if (missedFacts.length > 0) console.log(`     Missed: ${missedFacts.join(', ')}`);

        // Save response
        fs.writeFileSync(path.join(RESULTS_DIR, `response-${source}-to-${target}.txt`), response);
      } catch (e: any) {
        console.log(`     ⚠️  Error: ${e.message?.slice(0, 80)}`);
        results.push({
          id: testId,
          source,
          target,
          status: 'error',
          factsFound: 0,
          factsTotal: sourceData.keyFacts.length,
          factDetails: [],
          responsePreview: '',
          error: e.message?.slice(0, 200),
        });
      }
    }
  }

  // Step 3: Final report
  console.log('\n\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  RESULTS                                                      ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const err = results.filter((r) => r.status === 'error').length;

  // Matrix
  console.log('From / To      | Claude | Copilot | Gemini | Codex  | OpenCode');
  console.log('──────────────-|--------|---------|--------|--------|----------');
  for (const source of targets) {
    if (!picked.has(source)) continue;
    const cols = targets.map((target) => {
      if (target === source) return '   -  ';
      const r = results.find((r) => r.source === source && r.target === target);
      if (!r) return '   ?  ';
      if (r.status === 'pass') return ` ✅${r.factsFound}/${r.factsTotal}`;
      if (r.status === 'fail') return ` ❌${r.factsFound}/${r.factsTotal}`;
      return '  ⚠️   ';
    });
    console.log(`${source.padEnd(15)}| ${cols.join(' | ')}`);
  }

  console.log(`\n✅ PASS: ${pass}  ❌ FAIL: ${fail}  ⚠️ ERROR: ${err}  Total: ${results.length}`);

  // Save full results
  fs.writeFileSync(path.join(RESULTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nResults: ${RESULTS_DIR}/results.json`);

  // Exit code
  process.exit(fail + err);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

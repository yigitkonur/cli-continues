/**
 * Extract handoff markdown from the smallest real session of each source.
 * Saves to ~/.continues/e2e-test-results/handoff-from-{source}.md
 */
import {
  parseClaudeSessions, extractClaudeContext,
  parseCopilotSessions, extractCopilotContext,
  parseGeminiSessions, extractGeminiContext,
  parseCodexSessions, extractCodexContext,
  parseOpenCodeSessions, extractOpenCodeContext,
  parseDroidSessions, extractDroidContext,
} from '../parsers/index.js';
import type { UnifiedSession, SessionSource, SessionContext } from '../types/index.js';
import * as fs from 'fs';
import * as path from 'path';

const RESULTS_DIR = path.join(process.env.HOME || '~', '.continues', 'e2e-test-results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const ALL_SOURCES: SessionSource[] = ['claude', 'copilot', 'gemini', 'codex', 'opencode', 'droid'];

const parsers: Record<SessionSource, () => Promise<UnifiedSession[]>> = {
  claude: parseClaudeSessions,
  copilot: parseCopilotSessions,
  gemini: parseGeminiSessions,
  codex: parseCodexSessions,
  opencode: parseOpenCodeSessions,
  droid: parseDroidSessions,
};

const extractors: Record<SessionSource, (s: UnifiedSession) => Promise<SessionContext>> = {
  claude: extractClaudeContext,
  copilot: extractCopilotContext,
  gemini: extractGeminiContext,
  codex: extractCodexContext,
  opencode: extractOpenCodeContext,
  droid: extractDroidContext,
};

async function main() {
  const summary: Record<string, { sessionId: string; msgCount: number; mdSize: number; firstMsg: string }> = {};

  for (const source of ALL_SOURCES) {
    try {
      const sessions = await parsers[source]();
      if (sessions.length === 0) {
        console.error(`✗ ${source}: no sessions found`);
        continue;
      }

      // Find a session with actual messages (try smallest first, fallback to recent)
      let ctx: SessionContext | null = null;
      let usedSession: UnifiedSession | null = null;

      // Try recent sessions first (most likely to have content)
      for (const s of sessions.slice(0, 10)) {
        try {
          const c = await extractors[source](s);
          if (c.recentMessages.length > 0) {
            ctx = c;
            usedSession = s;
            break;
          }
        } catch { /* skip */ }
      }

      if (!ctx || !usedSession) {
        console.error(`✗ ${source}: no sessions with messages`);
        continue;
      }

      // Save handoff markdown
      const mdPath = path.join(RESULTS_DIR, `handoff-from-${source}.md`);
      fs.writeFileSync(mdPath, ctx.markdown);

      const firstUserMsg = ctx.recentMessages.find(m => m.role === 'user')?.content.slice(0, 80) || '(no user msg)';
      summary[source] = {
        sessionId: usedSession.id.slice(0, 16),
        msgCount: ctx.recentMessages.length,
        mdSize: ctx.markdown.length,
        firstMsg: firstUserMsg,
      };

      console.log(`✓ ${source}: ${ctx.recentMessages.length} msgs, ${ctx.markdown.length} bytes → ${mdPath}`);
    } catch (err) {
      console.error(`✗ ${source}: ${err}`);
    }
  }

  // Write summary JSON
  const summaryPath = path.join(RESULTS_DIR, 'extraction-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nSummary saved to ${summaryPath}`);

  // Print markdown previews
  for (const source of ALL_SOURCES) {
    const mdPath = path.join(RESULTS_DIR, `handoff-from-${source}.md`);
    if (fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, 'utf8');
      console.log(`\n${'='.repeat(60)}`);
      console.log(`HANDOFF FROM ${source.toUpperCase()} (${md.length} bytes):`);
      console.log(`${'='.repeat(60)}`);
      console.log(md.slice(0, 500));
      if (md.length > 500) console.log('...');
    }
  }
}

main().catch(console.error);

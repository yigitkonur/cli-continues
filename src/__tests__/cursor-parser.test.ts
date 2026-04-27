import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const tempDirs: string[] = [];

function makeCursorHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-parser-'));
  tempDirs.push(dir);
  return dir;
}

function writeCursorTranscript(home: string, slug: string, sessionId: string, rows: unknown[]): string {
  const dir = path.join(home, '.cursor', 'projects', slug, 'agent-transcripts', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

async function loadCursorParser(home: string): Promise<typeof import('../parsers/cursor.js')> {
  vi.resetModules();
  vi.doMock('../utils/parser-helpers.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/parser-helpers.js')>();
    return {
      ...actual,
      homeDir: () => home,
    };
  });
  return import('../parsers/cursor.js');
}

afterEach(() => {
  vi.doUnmock('../utils/parser-helpers.js');
  vi.resetModules();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('cursor parser confidence warnings', () => {
  it('includes a transcript completeness warning in extracted context', async () => {
    const home = makeCursorHome();
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const originalPath = writeCursorTranscript(home, 'Users-test-project', sessionId, [
      {
        role: 'user',
        message: {
          content: [{ type: 'text', text: 'Review auth flow' }],
        },
      },
      {
        role: 'assistant',
        message: {
          content: [{ type: 'text', text: 'I checked the transcript.' }],
        },
      },
    ]);

    const { extractCursorContext } = await loadCursorParser(home);
    const context = await extractCursorContext({
      id: sessionId,
      source: 'cursor',
      cwd: '/Users/test/project',
      repo: 'test/project',
      lines: 2,
      bytes: fs.statSync(originalPath).size,
      createdAt: new Date('2026-04-15T00:00:00.000Z'),
      updatedAt: new Date('2026-04-15T00:00:00.000Z'),
      originalPath,
      summary: 'Review auth flow',
    } satisfies UnifiedSession);

    expect(context.sessionNotes?.reasoning).toEqual(
      expect.arrayContaining([expect.stringContaining('Cursor transcript completeness warning')]),
    );
    expect(context.markdown).toContain('Cursor transcript completeness warning');
  });
});

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { UnifiedSession, SessionContext, ConversationMessage, ToolUsageSummary, SessionNotes } from '../types/index.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { SummaryCollector, shellSummary, fileSummary, grepSummary, globSummary, searchSummary, fetchSummary, mcpSummary, subagentSummary, withResult, truncate } from '../utils/tool-summarizer.js';

const CURSOR_PROJECTS_DIR = path.join(process.env.HOME || '~', '.cursor', 'projects');

/** Content block inside a Cursor message */
interface CursorContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  // tool_use fields
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result fields
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

/** A single JSONL line in Cursor agent-transcripts */
interface CursorTranscriptLine {
  role: 'user' | 'assistant';
  message: {
    content: CursorContentBlock[];
  };
}

/**
 * Derive cwd from the project slug directory name.
 * Cursor replaces both `/` and `.` with `-` in the slug, e.g.:
 *   "Users-evolution-Sites-localhost-dzcm-test" → "/Users/evolution/Sites/localhost/dzcm.test"
 *
 * Uses recursive backtracking: at each dash, tries `/`, `.`, or literal `-`.
 * Intermediate directories that don't yet exist on disk are still explored
 * because the final combined name (e.g. "dzcm.test") may exist.
 */
function cwdFromSlug(slug: string): string {
  const parts = slug.split('-');
  let best: string | null = null;

  function resolve(idx: number, segments: string[]): void {
    if (best) return; // already found a match

    if (idx >= parts.length) {
      const p = '/' + segments.join('/');
      if (fs.existsSync(p)) best = p;
      return;
    }

    const part = parts[idx];

    // Option 1: treat dash as path separator (new directory)
    resolve(idx + 1, [...segments, part]);
    if (best) return;

    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      const rest = segments.slice(0, -1);

      // Option 2: treat dash as dot (e.g. dzcm-test → dzcm.test)
      resolve(idx + 1, [...rest, last + '.' + part]);
      if (best) return;

      // Option 3: keep as literal dash (e.g. laravel-contentai)
      resolve(idx + 1, [...rest, last + '-' + part]);
    }
  }

  resolve(0, []);
  return best || '/' + slug.replace(/-/g, '/');
}

/**
 * Find all Cursor agent-transcript JSONL files.
 * Structure: ~/.cursor/projects/<project-slug>/agent-transcripts/<uuid>/<uuid>.jsonl
 */
async function findTranscriptFiles(): Promise<string[]> {
  const files: string[] = [];

  if (!fs.existsSync(CURSOR_PROJECTS_DIR)) {
    return files;
  }

  try {
    const projectDirs = fs.readdirSync(CURSOR_PROJECTS_DIR, { withFileTypes: true });
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;
      const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, projectDir.name, 'agent-transcripts');

      if (!fs.existsSync(transcriptsDir)) continue;

      try {
        const sessionDirs = fs.readdirSync(transcriptsDir, { withFileTypes: true });
        for (const sessionDir of sessionDirs) {
          if (!sessionDir.isDirectory()) continue;
          const jsonlPath = path.join(transcriptsDir, sessionDir.name, `${sessionDir.name}.jsonl`);
          if (fs.existsSync(jsonlPath)) {
            files.push(jsonlPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }
  } catch {
    // Skip if base dir can't be read
  }

  return files;
}

/**
 * Extract the project slug from a transcript file path.
 * Path: ~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl
 */
function getProjectSlug(filePath: string): string {
  const parts = filePath.split(path.sep);
  const projectsIdx = parts.indexOf('projects');
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
    return parts[projectsIdx + 1];
  }
  return '';
}

/**
 * Extract the session UUID from a transcript file path.
 */
function getSessionId(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

/**
 * Extract clean text from user_query tags if present
 */
function cleanUserQueryText(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  if (match) return match[1].trim();
  return text;
}

/**
 * Parse first few messages for summary
 */
async function parseSessionInfo(filePath: string): Promise<{
  firstUserMessage: string;
  lineCount: number;
}> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let firstUserMessage = '';
    let lineCount = 0;

    rl.on('line', (line) => {
      lineCount++;

      if (!firstUserMessage && lineCount <= 50) {
        try {
          const parsed = JSON.parse(line) as CursorTranscriptLine;
          if (parsed.role === 'user') {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                const cleaned = cleanUserQueryText(block.text);
                // Skip system-injected content
                if (cleaned && !cleaned.startsWith('<') && !cleaned.startsWith('/') && !cleaned.includes('Session Handoff')) {
                  firstUserMessage = cleaned;
                  break;
                }
              }
            }
          }
        } catch {
          // Skip invalid lines
        }
      }
    });

    rl.on('close', () => resolve({ firstUserMessage, lineCount }));
    rl.on('error', () => resolve({ firstUserMessage: '', lineCount: 0 }));
  });
}

/**
 * Extract repo name from cwd path
 */
function extractRepoFromCwd(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return parts[parts.length - 1] || '';
}

/**
 * Parse all Cursor sessions
 */
export async function parseCursorSessions(): Promise<UnifiedSession[]> {
  const files = await findTranscriptFiles();
  const sessions: UnifiedSession[] = [];

  for (const filePath of files) {
    try {
      const { firstUserMessage, lineCount } = await parseSessionInfo(filePath);
      const fileStats = fs.statSync(filePath);
      const slug = getProjectSlug(filePath);
      const cwd = cwdFromSlug(slug);

      const summary = firstUserMessage
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50);

      sessions.push({
        id: getSessionId(filePath),
        source: 'cursor',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines: lineCount,
        bytes: fileStats.size,
        createdAt: fileStats.birthtime,
        updatedAt: fileStats.mtime,
        originalPath: filePath,
        summary: summary || undefined,
      });
    } catch {
      // Skip files we can't parse
    }
  }

  return sessions
    .filter(s => s.bytes > 100)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Read all lines from a Cursor transcript
 */
async function readAllLines(filePath: string): Promise<CursorTranscriptLine[]> {
  return new Promise((resolve) => {
    const lines: CursorTranscriptLine[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        lines.push(JSON.parse(line) as CursorTranscriptLine);
      } catch {
        // Skip invalid lines
      }
    });

    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve(lines));
  });
}

/** Tools to skip — internal bookkeeping */
const CURSOR_SKIP_TOOLS = new Set(['TodoWrite']);

/**
 * Extract tool usage summaries and files modified using shared SummaryCollector.
 * Cursor uses Anthropic-style tool_use/tool_result content blocks.
 */
function extractToolData(lines: CursorTranscriptLine[]): { summaries: ToolUsageSummary[]; filesModified: string[] } {
  const collector = new SummaryCollector();
  const toolResultMap = new Map<string, string>();

  // First pass: collect all tool_result blocks
  for (const line of lines) {
    for (const block of line.message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      let text = '';
      if (typeof block.content === 'string') text = block.content;
      else if (Array.isArray(block.content)) {
        text = block.content.find(c => c.type === 'text')?.text || '';
      }
      if (text) toolResultMap.set(block.tool_use_id, text.slice(0, 100));
    }
  }

  // Second pass: process tool_use blocks
  for (const line of lines) {
    if (line.role !== 'assistant') continue;
    for (const block of line.message.content) {
      if (block.type !== 'tool_use' || !block.name) continue;

      const name = block.name;
      if (CURSOR_SKIP_TOOLS.has(name)) continue;

      const input = block.input || {};
      const result = block.id ? toolResultMap.get(block.id) : undefined;
      const fp = (input.file_path as string) || (input.path as string) || '';

      if (name === 'Bash' || name === 'bash' || name === 'terminal' || name === 'run_terminal_command') {
        collector.add('Bash', shellSummary((input.command as string) || '', result));
      } else if (['Read', 'ReadFile', 'read_file'].includes(name)) {
        collector.add(name, withResult(fileSummary('read', fp), result), fp);
      } else if (['Write', 'WriteFile', 'write_file', 'Create', 'create_file'].includes(name)) {
        collector.add(name, withResult(fileSummary('write', fp), result), fp, true);
      } else if (['Edit', 'EditFile', 'edit_file', 'apply_diff'].includes(name)) {
        collector.add(name, withResult(fileSummary('edit', fp), result), fp, true);
      } else if (name === 'Grep' || name === 'grep' || name === 'codebase_search') {
        collector.add('Grep', withResult(grepSummary((input.pattern as string) || (input.query as string) || '', (input.path as string) || ''), result));
      } else if (name === 'Glob' || name === 'glob' || name === 'list_directory' || name === 'file_search') {
        collector.add('Glob', withResult(globSummary((input.pattern as string) || (input.path as string) || ''), result));
      } else if (name === 'WebFetch' || name === 'web_fetch') {
        collector.add('WebFetch', fetchSummary((input.url as string) || ''));
      } else if (name === 'WebSearch' || name === 'web_search') {
        collector.add('WebSearch', searchSummary((input.query as string) || ''));
      } else if (name === 'Task' || name === 'task') {
        collector.add('Task', subagentSummary((input.description as string) || '', (input.subagent_type as string) || ''));
      } else if (name.startsWith('mcp__') || name.includes('___') || name.includes('-')) {
        collector.add(name, mcpSummary(name, JSON.stringify(input).slice(0, 100), result));
      } else {
        collector.add(name, withResult(`${name}(${JSON.stringify(input).slice(0, 100)})`, result));
      }
    }
  }

  return { summaries: collector.getSummaries(), filesModified: collector.getFilesModified() };
}

/**
 * Extract session notes from thinking blocks
 */
function extractSessionNotes(lines: CursorTranscriptLine[]): SessionNotes {
  const notes: SessionNotes = {};
  const reasoning: string[] = [];

  for (const line of lines) {
    if (line.role !== 'assistant') continue;
    for (const block of line.message.content) {
      if (block.type === 'thinking' && reasoning.length < 5) {
        const text = block.thinking || block.text || '';
        if (text.length > 20) {
          const firstLine = text.split(/[.\n]/)[0]?.trim();
          if (firstLine) reasoning.push(truncate(firstLine, 200));
        }
      }
    }
  }

  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}

/**
 * Extract context from a Cursor session for cross-tool continuation
 */
export async function extractCursorContext(session: UnifiedSession): Promise<SessionContext> {
  const lines = await readAllLines(session.originalPath);
  const recentMessages: ConversationMessage[] = [];

  const { summaries: toolSummaries, filesModified } = extractToolData(lines);
  const sessionNotes = extractSessionNotes(lines);
  const pendingTasks: string[] = [];

  for (const line of lines) {
    const textParts: string[] = [];
    for (const block of line.message.content) {
      if (block.type === 'text' && block.text) {
        // Skip system-injected content
        if (block.text.startsWith('<system-reminder>') || block.text.startsWith('<permissions')) continue;
        if (block.text.startsWith('<external_links>')) continue;
        if (block.text.startsWith('<image_files>')) continue;

        const cleaned = line.role === 'user' ? cleanUserQueryText(block.text) : block.text;
        if (cleaned) textParts.push(cleaned);
      }
    }

    const text = textParts.join('\n').trim();
    if (!text) continue;

    recentMessages.push({
      role: line.role === 'user' ? 'user' : 'assistant',
      content: text,
    });
  }

  const trimmed = recentMessages.slice(-10);

  const markdown = generateHandoffMarkdown(
    session,
    trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
  );

  return {
    session,
    recentMessages: trimmed,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}

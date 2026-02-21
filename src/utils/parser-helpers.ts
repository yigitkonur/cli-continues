import * as os from 'os';
import type { ConversationMessage } from '../types/index.js';
import { extractRepoFromGitUrl } from './content.js';

/**
 * Clean and truncate text for use as a session summary.
 * Collapses whitespace and newlines into a single line.
 */
export function cleanSummary(text: string, maxLen = 50): string {
  return text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Extract a short repo identifier from a working directory path.
 * Returns the last two path components joined with '/'.
 */
export function extractRepoFromCwd(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return parts[parts.length - 1] || '';
}

/**
 * Extract a repo identifier from a git URL (preferred) or fall back to cwd-based derivation.
 * Merges codex's extractRepoName + extractRepoFromCwd into one function.
 */
export function extractRepo(opts: { gitUrl?: string; cwd?: string }): string {
  if (opts.gitUrl) {
    const fromUrl = extractRepoFromGitUrl(opts.gitUrl);
    if (fromUrl) return fromUrl;
  }
  return extractRepoFromCwd(opts.cwd || '');
}

/**
 * Get the user's home directory reliably.
 * Preferred over `process.env.HOME || '~'` which doesn't expand on all platforms.
 */
export function homeDir(): string {
  return os.homedir();
}

/**
 * Trim messages to a balanced tail: keep the last `maxCount` messages
 * but ensure at least one user message is included.
 * Used by multiple parsers for the handoff conversation section.
 */
export function trimMessages(messages: ConversationMessage[], maxCount = 10): ConversationMessage[] {
  const tail = messages.slice(-maxCount);
  const hasUser = tail.some((m) => m.role === 'user');

  if (hasUser || messages.length <= maxCount) return tail;

  // Include the last user message + everything after it, capped at maxCount
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages.slice(i, i + maxCount);
    }
  }

  return tail;
}

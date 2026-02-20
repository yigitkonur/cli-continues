import * as os from 'os';

/**
 * Clean and truncate text for use as a session summary.
 * Collapses whitespace and newlines into a single line.
 */
export function cleanSummary(text: string, maxLen = 50): string {
  return text
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
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
 * Get the user's home directory reliably.
 * Preferred over `process.env.HOME || '~'` which doesn't expand on all platforms.
 */
export function homeDir(): string {
  return os.homedir();
}

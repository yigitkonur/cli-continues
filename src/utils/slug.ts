import * as fs from 'fs';

/**
 * Derive cwd from a slug directory name using recursive backtracking.
 * Slugs replace `/` and `.` with `-` in the directory name, e.g.:
 *   "Users-evolution-Sites-localhost-dzcm-test" → "/Users/evolution/Sites/localhost/dzcm.test"
 *
 * At each dash, tries: path separator `/`, dot `.`, or literal `-`.
 * Validates candidates with fs.existsSync(). Falls back to naive slash replacement.
 */
export function cwdFromSlug(slug: string): string {
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
 * Check if a session's cwd matches or is a subdirectory of targetDir.
 * Returns false for empty session cwds or root `/` target.
 */
export function matchesCwd(sessionCwd: string, targetDir: string): boolean {
  if (!sessionCwd || !targetDir) return false;
  const normTarget = targetDir.replace(/\/+$/, '');
  if (normTarget === '') return false; // guard against root '/'
  const normSession = sessionCwd.replace(/\/+$/, '');
  return normSession === normTarget || normSession.startsWith(normTarget + '/');
}

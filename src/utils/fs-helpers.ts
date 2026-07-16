/**
 * Shared filesystem helpers used by multiple parsers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../logger.js';

export interface FindFilesOptions {
  /** Filter predicate — return true to include a file */
  match: (entry: fs.Dirent, fullPath: string) => boolean;
  /** Recurse into subdirectories (default: true) */
  recursive?: boolean;
  /** Maximum directory depth to recurse (default: Infinity) */
  maxDepth?: number;
}

/**
 * Walk a directory and collect files matching a predicate.
 * Returns an empty array if the root doesn't exist.
 * Silently skips directories that can't be read.
 */
export function findFiles(root: string, options: FindFilesOptions): string[] {
  const files: string[] = [];

  if (!fs.existsSync(root)) return files;

  const recursive = options.recursive ?? true;
  const maxDepth = options.maxDepth ?? Infinity;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            const stat = fs.statSync(fullPath);
            isDir = stat.isDirectory();
            isFile = stat.isFile();
          } catch {
            continue; // broken symlink — skip gracefully
          }
        }
        if (isDir && recursive) {
          walk(fullPath, depth + 1);
        } else if (isFile && options.match(entry, fullPath)) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      logger.debug('findFiles: cannot read directory', dir, err);
    }
  };

  walk(root, 0);
  return files;
}

/**
 * List immediate subdirectories of a given path.
 * Returns an empty array if the path doesn't exist.
 */
export function listSubdirectories(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (e.isSymbolicLink()) {
          try {
            return fs.statSync(path.join(dir, e.name)).isDirectory();
          } catch {
            return false; // broken symlink — skip gracefully
          }
        }
        return false;
      })
      .map((e) => path.join(dir, e.name));
  } catch (err) {
    logger.debug('listSubdirectories: cannot read directory', dir, err);
    return [];
  }
}

/**
 * Map items with bounded async concurrency while preserving input order.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

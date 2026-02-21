/**
 * Shared JSONL reading utilities.
 * Replaces 5+ identical readAllMessages() functions across parsers.
 */
import * as fs from 'fs';
import * as readline from 'readline';
import { logger } from '../logger.js';

/**
 * Read an entire JSONL file into an array.
 * Each line is JSON.parse'd; invalid lines are silently skipped.
 * Returns an empty array if the file doesn't exist or can't be read.
 */
export async function readJsonlFile<T = unknown>(filePath: string): Promise<T[]> {
  if (!fs.existsSync(filePath)) return [];

  return new Promise((resolve) => {
    const items: T[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        items.push(JSON.parse(line));
      } catch (err) {
        logger.debug('jsonl: skipping invalid line in', filePath, err);
      }
    });

    rl.on('close', () => resolve(items));
    rl.on('error', () => resolve(items));
  });
}

/**
 * Scan the first N lines of a JSONL file, calling `visitor` on each parsed line.
 * The visitor returns 'continue' to keep reading or 'stop' to abort early.
 * Useful for extracting metadata from session headers without reading the full file.
 */
export async function scanJsonlHead(
  filePath: string,
  maxLines: number,
  visitor: (parsed: unknown, lineIndex: number) => 'continue' | 'stop',
): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineIndex = 0;
    let stopped = false;

    rl.on('line', (line) => {
      if (stopped || lineIndex >= maxLines) {
        if (!stopped) {
          stopped = true;
          rl.close();
          stream.close();
        }
        return;
      }

      try {
        const parsed = JSON.parse(line);
        const action = visitor(parsed, lineIndex);
        if (action === 'stop') {
          stopped = true;
          rl.close();
          stream.close();
        }
      } catch (err) {
        logger.debug('jsonl: skipping invalid line at index', lineIndex, 'in', filePath, err);
      }

      lineIndex++;
    });

    rl.on('close', () => resolve());
    rl.on('error', () => resolve());
  });
}

/**
 * Count lines in a file and return both count and file size in bytes.
 * Used by multiple parsers for session metadata.
 */
export async function getFileStats(filePath: string): Promise<{ lines: number; bytes: number }> {
  const stats = fs.statSync(filePath);

  return new Promise((resolve) => {
    let lines = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', () => lines++);
    rl.on('close', () => resolve({ lines, bytes: stats.size }));
    rl.on('error', () => resolve({ lines: 0, bytes: stats.size }));
  });
}

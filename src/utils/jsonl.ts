/**
 * Shared JSONL reading utilities.
 * Replaces 5+ identical readAllMessages() functions across parsers.
 */
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../logger.js';

const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024;

export interface JsonlReadOptions {
  /**
   * Maximum JSONL record size to buffer. Oversized records are skipped so
   * malformed or tool-output-heavy sessions cannot crash Node's readline buffer.
   */
  maxLineChars?: number;
  /** Maximum bytes to scan before returning. Leaves any partial trailing line unvisited. */
  maxBytes?: number;
}

/**
 * Stream a JSONL file line by line, invoking `visitor` for each raw line
 * (without JSON.parse). Newline handling, CR trimming, and oversized-line
 * skipping are shared. Used by parsers that need their own per-line decoding
 * (e.g. recovering glued JSON objects from a single physical line).
 */
export async function scanJsonlLines(
  filePath: string,
  visitor: (line: string, lineIndex: number) => 'continue' | 'stop',
  options: JsonlReadOptions = {},
): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const decoder = new StringDecoder('utf8');
  const stream = fs.createReadStream(filePath);
  let lineBuffer = '';
  let lineIndex = 0;
  let skippingOversizedLine = false;
  let stopped = false;
  let bytesRead = 0;

  const finishLine = (): 'continue' | 'stop' => {
    if (skippingOversizedLine) {
      logger.debug('jsonl: skipping oversized line at index', lineIndex, 'in', filePath);
      skippingOversizedLine = false;
      lineBuffer = '';
      lineIndex++;
      return 'continue';
    }

    const line = lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer;
    lineBuffer = '';
    const action = visitor(line, lineIndex);
    lineIndex++;
    return action;
  };

  const consumeText = (text: string): 'continue' | 'stop' => {
    let start = 0;

    while (start < text.length) {
      const newlineIndex = text.indexOf('\n', start);
      const segmentEnd = newlineIndex === -1 ? text.length : newlineIndex;
      const segment = text.slice(start, segmentEnd);

      if (!skippingOversizedLine) {
        if (lineBuffer.length + segment.length > maxLineChars) {
          skippingOversizedLine = true;
          lineBuffer = '';
        } else {
          lineBuffer += segment;
        }
      }

      if (newlineIndex === -1) {
        break;
      }

      if (finishLine() === 'stop') {
        return 'stop';
      }
      start = newlineIndex + 1;
    }

    return 'continue';
  };

  try {
    for await (const chunk of stream) {
      let buffer = chunk as Buffer;
      if (options.maxBytes !== undefined && bytesRead + buffer.length > options.maxBytes) {
        buffer = buffer.subarray(0, Math.max(0, options.maxBytes - bytesRead));
        stopped = true;
      }
      bytesRead += buffer.length;

      if (buffer.length > 0 && consumeText(decoder.write(buffer)) === 'stop') {
        stopped = true;
      }

      if (stopped) {
        stream.destroy();
        break;
      }
    }

    if (!stopped) {
      const remaining = decoder.end();
      if (remaining && consumeText(remaining) === 'stop') {
        stopped = true;
      }

      if (!stopped && (lineBuffer.length > 0 || skippingOversizedLine)) {
        finishLine();
      }
    }
  } catch (err) {
    logger.debug('jsonl: failed to stream', filePath, err);
  }
}

/**
 * Read an entire JSONL file into an array.
 * Each line is JSON.parse'd; invalid lines are silently skipped.
 * Returns an empty array if the file doesn't exist or can't be read.
 */
export async function readJsonlFile<T = unknown>(filePath: string, options?: JsonlReadOptions): Promise<T[]> {
  if (!fs.existsSync(filePath)) return [];

  const items: T[] = [];
  await scanJsonlLines(
    filePath,
    (line) => {
      try {
        items.push(JSON.parse(line));
      } catch (err) {
        logger.debug('jsonl: skipping invalid line in', filePath, err);
      }
      return 'continue';
    },
    options,
  );
  return items;
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
  options?: JsonlReadOptions,
): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  await scanJsonlLines(
    filePath,
    (line, lineIndex) => {
      if (lineIndex >= maxLines) return 'stop';
      try {
        const parsed = JSON.parse(line);
        return visitor(parsed, lineIndex);
      } catch {
        logger.debug('jsonl: skipping invalid line at index', lineIndex, 'in', filePath);
      }
      return 'continue';
    },
    options,
  );
}

/**
 * Scan every parsed JSONL line, calling `visitor` for each valid record.
 * The visitor returns 'continue' to keep reading or 'stop' to abort early.
 */
export async function scanJsonlFile(
  filePath: string,
  visitor: (parsed: unknown, lineIndex: number) => 'continue' | 'stop',
  options?: JsonlReadOptions,
): Promise<void> {
  if (!fs.existsSync(filePath)) return;

  await scanJsonlLines(
    filePath,
    (line, lineIndex) => {
      try {
        const parsed = JSON.parse(line);
        return visitor(parsed, lineIndex);
      } catch {
        logger.debug('jsonl: skipping invalid line at index', lineIndex, 'in', filePath);
      }
      return 'continue';
    },
    options,
  );
}

/**
 * Count lines in a file and return both count and file size in bytes.
 * Used by multiple parsers for session metadata.
 */
export async function getFileStats(filePath: string): Promise<{ lines: number; bytes: number }> {
  const stats = fs.statSync(filePath);
  if (stats.size === 0) return { lines: 0, bytes: stats.size };

  try {
    let lines = 0;
    let lastByte: number | undefined;
    const stream = fs.createReadStream(filePath);

    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      let offset = 0;
      let newlineIndex = buffer.indexOf(10, offset);
      while (newlineIndex !== -1) {
        lines++;
        offset = newlineIndex + 1;
        newlineIndex = buffer.indexOf(10, offset);
      }
      if (buffer.length > 0) {
        lastByte = buffer[buffer.length - 1];
      }
    }

    if (lastByte !== 10) lines++;
    return { lines, bytes: stats.size };
  } catch (err) {
    logger.debug('jsonl: failed to count lines in', filePath, err);
    return { lines: 0, bytes: stats.size };
  }
}

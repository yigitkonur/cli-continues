/**
 * Typed error hierarchy for continues.
 * Replaces anonymous Error throws with machine-readable error types.
 */

/**
 * Base error for all continues errors.
 * Includes an optional `cause` for error chaining.
 */
export class ContinuesError extends Error {
  override readonly name: string = 'ContinuesError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Thrown when a parser fails to read or interpret session data. */
export class ParseError extends ContinuesError {
  override readonly name = 'ParseError';
  constructor(
    public readonly source: string,
    public readonly filePath: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${source}] ${message} (${filePath})`, options);
  }
}

/** Thrown when a requested session cannot be found by ID or path. */
export class SessionNotFoundError extends ContinuesError {
  override readonly name = 'SessionNotFoundError';
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
  }
}

/** Thrown when a tool binary is not available on PATH. */
export class ToolNotAvailableError extends ContinuesError {
  override readonly name = 'ToolNotAvailableError';
  constructor(public readonly tool: string) {
    super(`Tool not available: ${tool}. Is it installed and on your PATH?`);
  }
}

/** Thrown when an unknown source name is provided. */
export class UnknownSourceError extends ContinuesError {
  override readonly name = 'UnknownSourceError';
  constructor(public readonly source: string) {
    super(`Unknown source: "${source}". Valid sources: claude, codex, copilot, gemini, opencode, droid, cursor`);
  }
}

/** Thrown when the session index cannot be read or written. */
export class IndexError extends ContinuesError {
  override readonly name = 'IndexError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Thrown when file storage operations fail (read/write handoff, cache). */
export class StorageError extends ContinuesError {
  override readonly name = 'StorageError';
  constructor(
    public readonly filePath: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${message}: ${filePath}`, options);
  }
}

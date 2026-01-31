import type { UnifiedSession, SessionSource, SessionContext } from '../types/index.js';
/**
 * Ensure continues directories exist
 */
export declare function ensureDirectories(): void;
/**
 * Check if index needs rebuilding
 */
export declare function indexNeedsRebuild(): boolean;
/**
 * Build the unified session index
 */
export declare function buildIndex(force?: boolean): Promise<UnifiedSession[]>;
/**
 * Load sessions from the index file
 */
export declare function loadIndex(): UnifiedSession[];
/**
 * Get all sessions (auto-rebuild if stale)
 */
export declare function getAllSessions(forceRebuild?: boolean): Promise<UnifiedSession[]>;
/**
 * Get sessions filtered by source
 */
export declare function getSessionsBySource(source: SessionSource, forceRebuild?: boolean): Promise<UnifiedSession[]>;
/**
 * Find a session by ID
 */
export declare function findSession(id: string): Promise<UnifiedSession | null>;
/**
 * Extract context from a session based on its source
 */
export declare function extractContext(session: UnifiedSession): Promise<SessionContext>;
/**
 * Save context to disk for cross-tool injection
 */
export declare function saveContext(context: SessionContext): string;
/**
 * Get cached context if available
 */
export declare function getCachedContext(sessionId: string): string | null;
/**
 * Format session for display
 */
export declare function formatSession(session: UnifiedSession): string;
/**
 * Format sessions as JSONL for output
 */
export declare function sessionsToJsonl(sessions: UnifiedSession[]): string;
//# sourceMappingURL=index.d.ts.map
import type { UnifiedSession, SessionContext } from '../types/index.js';
/**
 * Parse all Codex sessions
 */
export declare function parseCodexSessions(): Promise<UnifiedSession[]>;
/**
 * Extract context from a Codex session for cross-tool continuation
 */
export declare function extractCodexContext(session: UnifiedSession): Promise<SessionContext>;
//# sourceMappingURL=codex.d.ts.map
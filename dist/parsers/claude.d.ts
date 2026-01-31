import type { UnifiedSession, SessionContext } from '../types/index.js';
/**
 * Parse all Claude sessions
 */
export declare function parseClaudeSessions(): Promise<UnifiedSession[]>;
/**
 * Extract context from a Claude session for cross-tool continuation
 */
export declare function extractClaudeContext(session: UnifiedSession): Promise<SessionContext>;
//# sourceMappingURL=claude.d.ts.map
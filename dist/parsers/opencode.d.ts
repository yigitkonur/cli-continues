import type { UnifiedSession, SessionContext } from '../types/index.js';
/**
 * Parse all OpenCode sessions
 */
export declare function parseOpenCodeSessions(): Promise<UnifiedSession[]>;
/**
 * Extract context from an OpenCode session for cross-tool continuation
 */
export declare function extractOpenCodeContext(session: UnifiedSession): Promise<SessionContext>;
//# sourceMappingURL=opencode.d.ts.map
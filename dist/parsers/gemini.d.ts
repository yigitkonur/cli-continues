import type { UnifiedSession, SessionContext } from '../types/index.js';
/**
 * Parse all Gemini sessions
 */
export declare function parseGeminiSessions(): Promise<UnifiedSession[]>;
/**
 * Extract context from a Gemini session for cross-tool continuation
 */
export declare function extractGeminiContext(session: UnifiedSession): Promise<SessionContext>;
//# sourceMappingURL=gemini.d.ts.map
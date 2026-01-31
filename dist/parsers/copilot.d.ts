import type { UnifiedSession, SessionContext } from '../types/index.js';
/**
 * Parse all Copilot sessions
 */
export declare function parseCopilotSessions(): Promise<UnifiedSession[]>;
/**
 * Extract context from a Copilot session for cross-tool continuation
 */
export declare function extractCopilotContext(session: UnifiedSession): Promise<SessionContext>;
//# sourceMappingURL=copilot.d.ts.map
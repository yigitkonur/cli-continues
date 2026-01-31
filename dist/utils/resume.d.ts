import type { UnifiedSession, SessionSource } from '../types/index.js';
/**
 * Resume a session using native CLI commands
 */
export declare function nativeResume(session: UnifiedSession): Promise<void>;
/**
 * Resume a session in a different tool (cross-tool)
 */
export declare function crossToolResume(session: UnifiedSession, target: SessionSource): Promise<void>;
/**
 * Resume a session - automatically chooses native or cross-tool
 */
export declare function resume(session: UnifiedSession, target?: SessionSource): Promise<void>;
/**
 * Check if a CLI tool is available
 */
export declare function isToolAvailable(tool: SessionSource): Promise<boolean>;
/**
 * Get available tools
 */
export declare function getAvailableTools(): Promise<SessionSource[]>;
/**
 * Get resume command for display purposes
 */
export declare function getResumeCommand(session: UnifiedSession, target?: SessionSource): string;
//# sourceMappingURL=resume.d.ts.map
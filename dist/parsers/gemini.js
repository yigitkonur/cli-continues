import * as fs from 'fs';
import * as path from 'path';
const GEMINI_BASE_DIR = path.join(process.env.HOME || '~', '.gemini', 'tmp');
/**
 * Find all Gemini session files
 */
async function findSessionFiles() {
    const files = [];
    if (!fs.existsSync(GEMINI_BASE_DIR)) {
        return files;
    }
    try {
        // Iterate through project hash directories
        const projectDirs = fs.readdirSync(GEMINI_BASE_DIR, { withFileTypes: true });
        for (const projectDir of projectDirs) {
            if (!projectDir.isDirectory() || projectDir.name === 'bin')
                continue;
            const chatsDir = path.join(GEMINI_BASE_DIR, projectDir.name, 'chats');
            if (!fs.existsSync(chatsDir))
                continue;
            const chatFiles = fs.readdirSync(chatsDir, { withFileTypes: true });
            for (const chatFile of chatFiles) {
                if (chatFile.isFile() && chatFile.name.startsWith('session-') && chatFile.name.endsWith('.json')) {
                    files.push(path.join(chatsDir, chatFile.name));
                }
            }
        }
    }
    catch {
        // Skip directories we can't read
    }
    return files;
}
/**
 * Parse a single Gemini session file
 */
function parseSessionFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Extract first real user message from Gemini session
 */
function extractFirstUserMessage(session) {
    for (const msg of session.messages) {
        if (msg.type === 'user' && msg.content) {
            return msg.content;
        }
    }
    return '';
}
/**
 * Extract repo name from project path
 */
function extractRepoFromPath(projectPath) {
    const parts = projectPath.split('/').filter(Boolean);
    if (parts.length >= 2) {
        return parts.slice(-2).join('/');
    }
    return parts[parts.length - 1] || '';
}
/**
 * Parse all Gemini sessions
 */
export async function parseGeminiSessions() {
    const files = await findSessionFiles();
    const sessions = [];
    for (const filePath of files) {
        try {
            const session = parseSessionFile(filePath);
            if (!session || !session.sessionId)
                continue;
            // Get cwd from parent directory structure (project hash dir)
            const projectHashDir = path.dirname(path.dirname(filePath));
            const projectHash = path.basename(projectHashDir);
            // Try to get cwd - for now use the project hash dir path
            // In a real implementation, we might store a mapping
            const cwd = projectHashDir;
            const firstUserMessage = extractFirstUserMessage(session);
            const summary = firstUserMessage
                .replace(/\n/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 50);
            const fileStats = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').length;
            sessions.push({
                id: session.sessionId,
                source: 'gemini',
                cwd,
                repo: extractRepoFromPath(cwd),
                lines,
                bytes: fileStats.size,
                createdAt: new Date(session.startTime),
                updatedAt: new Date(session.lastUpdated),
                originalPath: filePath,
                summary: summary || undefined,
            });
        }
        catch {
            // Skip files we can't parse
        }
    }
    // Filter sessions that have real user messages (not just auth flows)
    return sessions
        .filter(s => s.summary && s.summary.length > 0)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
/**
 * Extract context from a Gemini session for cross-tool continuation
 */
export async function extractGeminiContext(session) {
    const sessionData = parseSessionFile(session.originalPath);
    const recentMessages = [];
    const filesModified = [];
    const pendingTasks = [];
    if (sessionData) {
        // Process messages to extract conversation
        for (const msg of sessionData.messages.slice(-20)) {
            if (msg.type === 'user') {
                recentMessages.push({
                    role: 'user',
                    content: msg.content,
                    timestamp: new Date(msg.timestamp),
                });
            }
            else if (msg.type === 'gemini' && msg.content) {
                recentMessages.push({
                    role: 'assistant',
                    content: msg.content,
                    timestamp: new Date(msg.timestamp),
                });
            }
        }
    }
    const markdown = generateHandoffMarkdown(session, recentMessages.slice(-10), filesModified, pendingTasks);
    return {
        session,
        recentMessages: recentMessages.slice(-10),
        filesModified,
        pendingTasks,
        markdown,
    };
}
/**
 * Generate markdown handoff document
 */
function generateHandoffMarkdown(session, messages, filesModified, pendingTasks) {
    const lines = [
        '# Session Handoff Context',
        '',
        '## Original Session',
        `- **Source**: Gemini CLI`,
        `- **Session ID**: ${session.id}`,
        `- **Working Directory**: ${session.cwd}`,
        session.repo ? `- **Repository**: ${session.repo}` : '',
        `- **Last Active**: ${session.updatedAt.toISOString()}`,
        '',
        '## Recent Conversation',
        '',
    ];
    for (const msg of messages.slice(-5)) {
        lines.push(`### ${msg.role === 'user' ? 'User' : 'Assistant'}`);
        lines.push(msg.content.slice(0, 500) + (msg.content.length > 500 ? '...' : ''));
        lines.push('');
    }
    if (filesModified.length > 0) {
        lines.push('## Files Modified');
        for (const file of filesModified) {
            lines.push(`- ${file}`);
        }
        lines.push('');
    }
    if (pendingTasks.length > 0) {
        lines.push('## Pending Tasks');
        for (const task of pendingTasks) {
            lines.push(`- [ ] ${task}`);
        }
        lines.push('');
    }
    lines.push('---');
    lines.push('**Continue this session. The context above summarizes the previous work.**');
    return lines.filter(l => l !== '').join('\n');
}
//# sourceMappingURL=gemini.js.map
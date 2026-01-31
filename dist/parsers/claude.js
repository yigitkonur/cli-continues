import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || '~', '.claude', 'projects');
/**
 * Find all Claude session files recursively
 */
async function findSessionFiles() {
    const files = [];
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
        return files;
    }
    const walkDir = (dir) => {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walkDir(fullPath);
                }
                else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('debug')) {
                    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i.test(entry.name)) {
                        files.push(fullPath);
                    }
                }
            }
        }
        catch {
            // Skip directories we can't read
        }
    };
    walkDir(CLAUDE_PROJECTS_DIR);
    return files;
}
/**
 * Parse session metadata and first user message
 */
async function parseSessionInfo(filePath) {
    return new Promise((resolve) => {
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let sessionId = '';
        let cwd = '';
        let gitBranch = '';
        let firstUserMessage = '';
        let linesRead = 0;
        rl.on('line', (line) => {
            linesRead++;
            if (linesRead > 50) {
                rl.close();
                stream.close();
                return;
            }
            try {
                const parsed = JSON.parse(line);
                if (parsed.sessionId && !sessionId)
                    sessionId = parsed.sessionId;
                if (parsed.cwd && !cwd)
                    cwd = parsed.cwd;
                if (parsed.gitBranch && !gitBranch)
                    gitBranch = parsed.gitBranch;
                // Extract first real user message (not meta/commands)
                if (!firstUserMessage && parsed.type === 'user' && parsed.message?.content) {
                    const content = typeof parsed.message.content === 'string'
                        ? parsed.message.content
                        : parsed.message.content.find(c => c.type === 'text')?.text || '';
                    // Skip command-like messages, meta content, and continuation summaries
                    if (content && !content.startsWith('<') && !content.startsWith('/') && !content.includes('Session Handoff')) {
                        firstUserMessage = content;
                    }
                }
            }
            catch {
                // Skip invalid lines
            }
        });
        rl.on('close', () => {
            if (!sessionId) {
                sessionId = path.basename(filePath, '.jsonl');
            }
            resolve({ sessionId, cwd, gitBranch, firstUserMessage });
        });
        rl.on('error', () => resolve({ sessionId: '', cwd: '', firstUserMessage: '' }));
    });
}
/**
 * Count lines and get file size
 */
async function getFileStats(filePath) {
    return new Promise((resolve) => {
        const stats = fs.statSync(filePath);
        let lines = 0;
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', () => lines++);
        rl.on('close', () => resolve({ lines, bytes: stats.size }));
        rl.on('error', () => resolve({ lines: 0, bytes: stats.size }));
    });
}
/**
 * Extract repo name from cwd path
 */
function extractRepoFromCwd(cwd) {
    if (!cwd)
        return '';
    const parts = cwd.split('/').filter(Boolean);
    if (parts.length >= 2) {
        return parts.slice(-2).join('/');
    }
    return parts[parts.length - 1] || '';
}
/**
 * Parse all Claude sessions
 */
export async function parseClaudeSessions() {
    const files = await findSessionFiles();
    const sessions = [];
    for (const filePath of files) {
        try {
            const info = await parseSessionInfo(filePath);
            const stats = await getFileStats(filePath);
            const fileStats = fs.statSync(filePath);
            // Use first user message as summary
            const summary = info.firstUserMessage
                .replace(/\n/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 50);
            const repo = extractRepoFromCwd(info.cwd);
            sessions.push({
                id: info.sessionId,
                source: 'claude',
                cwd: info.cwd,
                repo,
                branch: info.gitBranch,
                lines: stats.lines,
                bytes: stats.bytes,
                createdAt: fileStats.birthtime,
                updatedAt: fileStats.mtime,
                originalPath: filePath,
                summary: summary || undefined,
            });
        }
        catch {
            // Skip files we can't parse
        }
    }
    return sessions
        .filter(s => s.bytes > 200)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
/**
 * Read all messages from a Claude session
 */
async function readAllMessages(filePath) {
    return new Promise((resolve) => {
        const messages = [];
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
            try {
                messages.push(JSON.parse(line));
            }
            catch {
                // Skip invalid lines
            }
        });
        rl.on('close', () => resolve(messages));
        rl.on('error', () => resolve(messages));
    });
}
/**
 * Extract content from Claude message
 */
function extractContent(msg) {
    if (!msg.message?.content)
        return '';
    if (typeof msg.message.content === 'string') {
        return msg.message.content;
    }
    return msg.message.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text)
        .join('\n');
}
/**
 * Extract context from a Claude session for cross-tool continuation
 */
export async function extractClaudeContext(session) {
    const messages = await readAllMessages(session.originalPath);
    const recentMessages = [];
    const filesModified = [];
    const pendingTasks = [];
    for (const msg of messages.slice(-100)) {
        if (msg.type === 'user') {
            const content = extractContent(msg);
            if (content) {
                recentMessages.push({
                    role: 'user',
                    content,
                    timestamp: new Date(msg.timestamp),
                });
            }
        }
        else if (msg.type === 'assistant') {
            const content = extractContent(msg);
            if (content) {
                recentMessages.push({
                    role: 'assistant',
                    content,
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
        `- **Source**: Claude Code`,
        `- **Session ID**: ${session.id}`,
        `- **Working Directory**: ${session.cwd}`,
        session.repo ? `- **Repository**: ${session.repo}${session.branch ? ` @ ${session.branch}` : ''}` : '',
        session.branch && !session.repo ? `- **Branch**: ${session.branch}` : '',
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
//# sourceMappingURL=claude.js.map
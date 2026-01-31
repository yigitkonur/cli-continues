import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import YAML from 'yaml';
const COPILOT_SESSIONS_DIR = path.join(process.env.HOME || '~', '.copilot', 'session-state');
/**
 * Find all Copilot session directories
 */
async function findSessionDirs() {
    const dirs = [];
    if (!fs.existsSync(COPILOT_SESSIONS_DIR)) {
        return dirs;
    }
    try {
        const entries = fs.readdirSync(COPILOT_SESSIONS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const sessionDir = path.join(COPILOT_SESSIONS_DIR, entry.name);
                const workspaceFile = path.join(sessionDir, 'workspace.yaml');
                // Must have workspace.yaml to be a valid session
                if (fs.existsSync(workspaceFile)) {
                    dirs.push(sessionDir);
                }
            }
        }
    }
    catch {
        // Skip if we can't read the directory
    }
    return dirs;
}
/**
 * Parse workspace.yaml file
 */
function parseWorkspace(workspacePath) {
    try {
        const content = fs.readFileSync(workspacePath, 'utf8');
        return YAML.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Count lines and get file size for events.jsonl
 */
async function getEventsStats(eventsPath) {
    if (!fs.existsSync(eventsPath)) {
        return { lines: 0, bytes: 0 };
    }
    return new Promise((resolve) => {
        const stats = fs.statSync(eventsPath);
        let lines = 0;
        const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', () => lines++);
        rl.on('close', () => resolve({ lines, bytes: stats.size }));
        rl.on('error', () => resolve({ lines: 0, bytes: stats.size }));
    });
}
/**
 * Extract model from events.jsonl
 */
async function extractModel(eventsPath) {
    if (!fs.existsSync(eventsPath)) {
        return undefined;
    }
    return new Promise((resolve) => {
        const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
            try {
                const event = JSON.parse(line);
                if (event.type === 'session.start' && event.data?.selectedModel) {
                    rl.close();
                    stream.close();
                    resolve(event.data.selectedModel);
                    return;
                }
            }
            catch {
                // Skip invalid lines
            }
        });
        rl.on('close', () => resolve(undefined));
        rl.on('error', () => resolve(undefined));
    });
}
/**
 * Parse all Copilot sessions
 */
export async function parseCopilotSessions() {
    const dirs = await findSessionDirs();
    const sessions = [];
    for (const sessionDir of dirs) {
        try {
            const workspacePath = path.join(sessionDir, 'workspace.yaml');
            const eventsPath = path.join(sessionDir, 'events.jsonl');
            const workspace = parseWorkspace(workspacePath);
            if (!workspace)
                continue;
            const stats = await getEventsStats(eventsPath);
            const model = await extractModel(eventsPath);
            // Parse summary - handle multiline YAML
            let summary = workspace.summary || '';
            if (summary.startsWith('|')) {
                summary = summary.replace(/^\|\n?/, '').split('\n')[0];
            }
            sessions.push({
                id: workspace.id,
                source: 'copilot',
                cwd: workspace.cwd,
                repo: workspace.repository,
                branch: workspace.branch,
                lines: stats.lines,
                bytes: stats.bytes,
                createdAt: new Date(workspace.created_at),
                updatedAt: new Date(workspace.updated_at),
                originalPath: sessionDir,
                summary: summary.slice(0, 60),
                model,
            });
        }
        catch {
            // Skip sessions we can't parse
        }
    }
    // Filter out empty sessions and sort by update time
    return sessions
        .filter(s => s.bytes > 0)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
/**
 * Read all events from a Copilot session
 */
async function readAllEvents(eventsPath) {
    if (!fs.existsSync(eventsPath)) {
        return [];
    }
    return new Promise((resolve) => {
        const events = [];
        const stream = fs.createReadStream(eventsPath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
            try {
                events.push(JSON.parse(line));
            }
            catch {
                // Skip invalid lines
            }
        });
        rl.on('close', () => resolve(events));
        rl.on('error', () => resolve(events));
    });
}
/**
 * Extract context from a Copilot session for cross-tool continuation
 */
export async function extractCopilotContext(session) {
    const eventsPath = path.join(session.originalPath, 'events.jsonl');
    const events = await readAllEvents(eventsPath);
    const recentMessages = [];
    const filesModified = [];
    const pendingTasks = [];
    // Process events to extract conversation
    for (const event of events.slice(-100)) { // Last 100 events
        if (event.type === 'user.message') {
            const content = event.data?.content || event.data?.transformedContent || '';
            if (content) {
                recentMessages.push({
                    role: 'user',
                    content,
                    timestamp: new Date(event.timestamp),
                });
            }
        }
        else if (event.type === 'assistant.message') {
            const content = event.data?.content || '';
            if (content) {
                recentMessages.push({
                    role: 'assistant',
                    content: typeof content === 'string' ? content : JSON.stringify(content),
                    timestamp: new Date(event.timestamp),
                    toolCalls: event.data?.toolRequests?.map(t => ({
                        name: t.name,
                        arguments: t.arguments,
                    })),
                });
            }
        }
    }
    // Generate markdown for injection
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
        `- **Source**: GitHub Copilot CLI`,
        `- **Session ID**: ${session.id}`,
        `- **Working Directory**: ${session.cwd}`,
        session.repo ? `- **Repository**: ${session.repo}${session.branch ? ` @ ${session.branch}` : ''}` : '',
        session.model ? `- **Model**: ${session.model}` : '',
        `- **Last Active**: ${session.updatedAt.toISOString()}`,
        '',
    ];
    if (session.summary) {
        lines.push('## Summary');
        lines.push(session.summary);
        lines.push('');
    }
    lines.push('## Recent Conversation');
    lines.push('');
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
//# sourceMappingURL=copilot.js.map
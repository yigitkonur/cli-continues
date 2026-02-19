/**
 * Test fixtures - sanitized session data for all 5 tools
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface FixtureDir {
  root: string;
  cleanup: () => void;
}

/**
 * Create a temporary directory with Claude session fixtures
 */
export function createClaudeFixture(): FixtureDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-claude-'));
  const projectDir = path.join(root, '-test-project');
  fs.mkdirSync(projectDir, { recursive: true });

  const sessionFile = path.join(projectDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  const lines = [
    JSON.stringify({
      type: 'system',
      uuid: '00000000-0000-0000-0000-000000000001',
      timestamp: '2026-01-15T10:00:00.000Z',
      sessionId: 'test-claude-session-1',
      cwd: '/home/user/project',
      gitBranch: 'main',
      slug: 'test-session',
      message: { role: 'system', content: 'Session started' },
    }),
    JSON.stringify({
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000002',
      timestamp: '2026-01-15T10:00:01.000Z',
      sessionId: 'test-claude-session-1',
      cwd: '/home/user/project',
      message: { role: 'user', content: 'Fix the authentication bug in login.ts' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: '00000000-0000-0000-0000-000000000003',
      timestamp: '2026-01-15T10:00:05.000Z',
      sessionId: 'test-claude-session-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I found the issue in login.ts. The token validation was missing.' }],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000004',
      timestamp: '2026-01-15T10:00:10.000Z',
      sessionId: 'test-claude-session-1',
      message: { role: 'user', content: 'Great, please also add error handling' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: '00000000-0000-0000-0000-000000000005',
      timestamp: '2026-01-15T10:00:15.000Z',
      sessionId: 'test-claude-session-1',
      message: {
        role: 'assistant',
        content: 'Done. I added try-catch blocks and proper error messages.',
      },
    }),
  ];

  fs.writeFileSync(sessionFile, lines.join('\n') + '\n');

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Create a temporary directory with Copilot session fixtures
 */
export function createCopilotFixture(): FixtureDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-copilot-'));
  const sessionDir = path.join(root, 'test-session-001');
  fs.mkdirSync(sessionDir, { recursive: true });

  // workspace.yaml
  const workspace = `id: test-copilot-session-1
cwd: /home/user/project
summary: Fix authentication bug
summary_count: 0
created_at: 2026-01-15T10:00:00.000Z
updated_at: 2026-01-15T10:05:00.000Z
`;
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), workspace);

  // events.jsonl
  const events = [
    JSON.stringify({
      type: 'session.start',
      data: {
        sessionId: 'test-copilot-session-1',
        version: 1,
        producer: 'copilot-agent',
        copilotVersion: '0.0.400',
        startTime: '2026-01-15T10:00:00.000Z',
        context: { cwd: '/home/user/project' },
        selectedModel: 'claude-sonnet-4',
      },
      id: 'evt-001',
      timestamp: '2026-01-15T10:00:00.000Z',
      parentId: null,
    }),
    JSON.stringify({
      type: 'user.message',
      data: {
        content: 'Fix the authentication bug in login.ts',
        transformedContent: 'Fix the authentication bug in login.ts',
      },
      id: 'evt-002',
      timestamp: '2026-01-15T10:00:01.000Z',
      parentId: 'evt-001',
    }),
    JSON.stringify({
      type: 'assistant.message',
      data: {
        messageId: 'msg-001',
        content: 'I found the issue in login.ts. The token validation was missing.',
        toolRequests: [],
      },
      id: 'evt-003',
      timestamp: '2026-01-15T10:00:05.000Z',
      parentId: 'evt-002',
    }),
    JSON.stringify({
      type: 'user.message',
      data: {
        content: 'Great, please also add error handling',
      },
      id: 'evt-004',
      timestamp: '2026-01-15T10:00:10.000Z',
      parentId: 'evt-003',
    }),
    JSON.stringify({
      type: 'assistant.message',
      data: {
        messageId: 'msg-002',
        content: 'Done. I added try-catch blocks and proper error messages.',
      },
      id: 'evt-005',
      timestamp: '2026-01-15T10:00:15.000Z',
      parentId: 'evt-004',
    }),
  ];

  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), events.join('\n') + '\n');

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Create a temporary directory with Gemini session fixtures
 */
export function createGeminiFixture(): FixtureDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gemini-'));
  const projectHashDir = path.join(root, 'abc123hash');
  const chatsDir = path.join(projectHashDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });

  const session = {
    sessionId: 'test-gemini-session-1',
    projectHash: 'abc123hash',
    startTime: '2026-01-15T10:00:00.000Z',
    lastUpdated: '2026-01-15T10:05:00.000Z',
    messages: [
      {
        id: 'msg-001',
        timestamp: '2026-01-15T10:00:01.000Z',
        type: 'user',
        content: 'Fix the authentication bug in login.ts',
      },
      {
        id: 'msg-002',
        timestamp: '2026-01-15T10:00:05.000Z',
        type: 'gemini',
        content: '',
        toolCalls: [
          {
            id: 'tc-001',
            name: 'read_file',
            args: { file_path: 'login.ts' },
          },
        ],
      },
      {
        id: 'msg-003',
        timestamp: '2026-01-15T10:00:08.000Z',
        type: 'gemini',
        content: 'I found the issue in login.ts. The token validation was missing.',
      },
      {
        id: 'msg-004',
        timestamp: '2026-01-15T10:00:10.000Z',
        type: 'user',
        content: 'Great, please also add error handling',
      },
      {
        id: 'msg-005',
        timestamp: '2026-01-15T10:00:15.000Z',
        type: 'gemini',
        content: 'Done. I added try-catch blocks and proper error messages.',
      },
    ],
  };

  fs.writeFileSync(
    path.join(chatsDir, 'session-2026-01-15T10-00-test1234.json'),
    JSON.stringify(session, null, 2)
  );

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Create a temporary directory with Codex session fixtures
 */
export function createCodexFixture(): FixtureDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-codex-'));
  const dateDir = path.join(root, '2026', '01', '15');
  fs.mkdirSync(dateDir, { recursive: true });

  const lines = [
    JSON.stringify({
      timestamp: '2026-01-15T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'test-codex-uuid-1234',
        timestamp: '2026-01-15T10:00:00.000Z',
        cwd: '/home/user/project',
        originator: 'codex_cli_rs',
        cli_version: '0.93.0',
        source: 'cli',
        git: {
          branch: 'main',
          repository_url: 'https://github.com/user/project.git',
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-01-15T10:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Fix the authentication bug in login.ts',
      },
    }),
    JSON.stringify({
      timestamp: '2026-01-15T10:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'I found the issue in login.ts. The token validation was missing.',
      },
    }),
    JSON.stringify({
      timestamp: '2026-01-15T10:00:10.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Great, please also add error handling',
      },
    }),
    JSON.stringify({
      timestamp: '2026-01-15T10:00:15.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Done. I added try-catch blocks and proper error messages.',
      },
    }),
  ];

  const filename = 'rollout-2026-01-15T10-00-00-test-codex-uuid-1234.jsonl';
  fs.writeFileSync(path.join(dateDir, filename), lines.join('\n') + '\n');

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Create a temporary SQLite database with OpenCode session fixtures
 */
export function createOpenCodeSqliteFixture(): FixtureDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-opencode-'));
  const dbPath = path.join(root, 'opencode.db');

  // Use node:sqlite to create the DB
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL DEFAULT '[]',
      commands TEXT
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      FOREIGN KEY (project_id) REFERENCES project(id)
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id)
    );
  `);

  const now = Date.now();

  // Insert project
  db.prepare('INSERT INTO project VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'proj_test1', '/home/user/project', 'git', 'project', null, null, now - 10000, now, null, '[]', null
  );

  // Insert session
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'ses_test1', 'proj_test1', null, 'test-session', '/home/user/project',
    'Fix authentication bug', '1.2.0', null, 2, 0, 1, null, null, null, now - 5000, now, null, null
  );

  // Insert user message
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'msg_user1', 'ses_test1', now - 4000, now - 4000,
    JSON.stringify({ role: 'user', time: { created: now - 4000 } })
  );
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt_user1', 'msg_user1', 'ses_test1', now - 4000, now - 4000,
    JSON.stringify({ type: 'text', text: 'Fix the authentication bug in login.ts' })
  );

  // Insert assistant message
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'msg_asst1', 'ses_test1', now - 3000, now - 3000,
    JSON.stringify({ role: 'assistant', time: { created: now - 3000, completed: now - 2500 }, modelID: 'claude-opus-4.6' })
  );
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt_asst1', 'msg_asst1', 'ses_test1', now - 3000, now - 3000,
    JSON.stringify({ type: 'text', text: 'I found the issue in login.ts. The token validation was missing.' })
  );

  // Insert another user message
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'msg_user2', 'ses_test1', now - 2000, now - 2000,
    JSON.stringify({ role: 'user', time: { created: now - 2000 } })
  );
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt_user2', 'msg_user2', 'ses_test1', now - 2000, now - 2000,
    JSON.stringify({ type: 'text', text: 'Great, please also add error handling' })
  );

  // Insert another assistant message
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'msg_asst2', 'ses_test1', now - 1000, now - 1000,
    JSON.stringify({ role: 'assistant', time: { created: now - 1000, completed: now - 500 } })
  );
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'prt_asst2', 'msg_asst2', 'ses_test1', now - 1000, now - 1000,
    JSON.stringify({ type: 'text', text: 'Done. I added try-catch blocks and proper error messages.' })
  );

  db.close();

  // Also create legacy JSON storage dir (empty)
  fs.mkdirSync(path.join(root, 'storage', 'session', 'proj_test1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'storage', 'message'), { recursive: true });
  fs.mkdirSync(path.join(root, 'storage', 'part'), { recursive: true });
  fs.mkdirSync(path.join(root, 'storage', 'project'), { recursive: true });

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Create a temporary directory with Droid session fixtures
 */
export function createDroidFixture(): FixtureDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-droid-'));
  const workspaceDir = path.join(root, '-home-user-project');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const sessionId = 'dddddddd-1111-2222-3333-444444444444';

  // Create .settings.json
  const settings = {
    assistantActiveTimeMs: 15000,
    model: 'claude-opus-4-6',
    reasoningEffort: 'max',
    interactionMode: 'auto',
    autonomyMode: 'auto-low',
    tokenUsage: {
      inputTokens: 5000,
      outputTokens: 1200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 50,
    },
  };
  fs.writeFileSync(path.join(workspaceDir, `${sessionId}.settings.json`), JSON.stringify(settings, null, 2));

  // Create JSONL session
  const lines = [
    JSON.stringify({
      type: 'session_start',
      id: sessionId,
      title: 'Fix authentication bug',
      sessionTitle: 'Auth Bug Fix',
      owner: 'testuser',
      version: 2,
      cwd: '/home/user/project',
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-001',
      timestamp: '2026-01-15T10:00:01.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Fix the authentication bug in login.ts' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-002',
      timestamp: '2026-01-15T10:00:05.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc-001', name: 'Read', input: { file_path: '/home/user/project/login.ts' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-003',
      timestamp: '2026-01-15T10:00:06.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc-001', content: 'export function login() { ... }' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-004',
      timestamp: '2026-01-15T10:00:08.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc-002', name: 'Edit', input: { file_path: '/home/user/project/login.ts', old_str: 'old code', new_str: 'new code' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-005',
      timestamp: '2026-01-15T10:00:09.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc-002', content: 'File edited successfully' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-006',
      timestamp: '2026-01-15T10:00:10.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I found the issue in login.ts. The token validation was missing.' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-007',
      timestamp: '2026-01-15T10:00:12.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Great, please also add error handling' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'msg-008',
      timestamp: '2026-01-15T10:00:15.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done. I added try-catch blocks and proper error messages.' }],
      },
    }),
    JSON.stringify({
      type: 'todo_state',
      id: 'todo-001',
      timestamp: '2026-01-15T10:00:15.000Z',
      todos: { todos: '1. [completed] Fix token validation\n2. [in_progress] Add error handling\n3. [pending] Write tests' },
      messageIndex: 3,
    }),
  ];

  fs.writeFileSync(path.join(workspaceDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Create OpenCode JSON-only fixture (legacy format)
 */
export function createOpenCodeJsonFixture(): FixtureDir {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-opencode-json-'));
  const storageDir = path.join(root, 'storage');
  const projectId = 'proj_test1';
  const sessionId = 'ses_test_json_1';

  // Create session file
  const sessionDir = path.join(storageDir, 'session', projectId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(sessionDir, `${sessionId}.json`),
    JSON.stringify({
      id: sessionId,
      slug: 'json-test-session',
      version: '1.1.47',
      projectID: projectId,
      directory: '/home/user/project',
      title: 'Fix authentication bug (JSON)',
      time: { created: now - 5000, updated: now },
    })
  );

  // Create project file
  const projectDir = path.join(storageDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${projectId}.json`),
    JSON.stringify({ id: projectId, worktree: '/home/user/project' })
  );

  // Create message files
  const msgDir = path.join(storageDir, 'message', sessionId);
  fs.mkdirSync(msgDir, { recursive: true });
  fs.writeFileSync(
    path.join(msgDir, 'msg_u1.json'),
    JSON.stringify({
      id: 'msg_u1',
      sessionID: sessionId,
      role: 'user',
      time: { created: now - 4000 },
    })
  );
  fs.writeFileSync(
    path.join(msgDir, 'msg_a1.json'),
    JSON.stringify({
      id: 'msg_a1',
      sessionID: sessionId,
      role: 'assistant',
      time: { created: now - 3000, completed: now - 2500 },
    })
  );

  // Create part files
  const partDirU1 = path.join(storageDir, 'part', 'msg_u1');
  fs.mkdirSync(partDirU1, { recursive: true });
  fs.writeFileSync(
    path.join(partDirU1, 'prt_u1.json'),
    JSON.stringify({ id: 'prt_u1', sessionID: sessionId, messageID: 'msg_u1', type: 'text', text: 'Fix the authentication bug in login.ts' })
  );

  const partDirA1 = path.join(storageDir, 'part', 'msg_a1');
  fs.mkdirSync(partDirA1, { recursive: true });
  fs.writeFileSync(
    path.join(partDirA1, 'prt_a1.json'),
    JSON.stringify({ id: 'prt_a1', sessionID: sessionId, messageID: 'msg_a1', type: 'text', text: 'I found the issue. The token validation was missing.' })
  );

  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

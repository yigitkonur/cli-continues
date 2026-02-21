/**
 * Zod schemas for all parser raw data formats and serialized session.
 * Each schema validates untrusted data from disk (JSONL, JSON, YAML, SQLite).
 * Schemas use .passthrough() to tolerate extra fields from future tool versions.
 */
import { z } from 'zod';
import { ContentBlockSchema } from './content-blocks.js';
import { TOOL_NAMES } from './tool-names.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Content that can be a string or an array of blocks */
const StringOrBlockArray = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
]);

// ── Claude ──────────────────────────────────────────────────────────────────

export const ClaudeMessageSchema = z
  .object({
    type: z.string(),
    uuid: z.string(),
    timestamp: z.string(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    slug: z.string().optional(),
    model: z.string().optional(),
    isCompactSummary: z.boolean().optional(),
    parentUuid: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z
          .union([
            z.string(),
            z.array(ContentBlockSchema.or(z.object({ type: z.string(), text: z.string().optional() }).passthrough())),
          ])
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type ClaudeMessage = z.infer<typeof ClaudeMessageSchema>;

// ── Codex ───────────────────────────────────────────────────────────────────

/** Codex messages are a discriminated union on the `type` field */
export const CodexSessionMetaSchema = z
  .object({
    timestamp: z.string(),
    type: z.literal('session_meta'),
    payload: z
      .object({
        id: z.string().optional(),
        cwd: z.string().optional(),
        git: z
          .object({
            branch: z.string().optional(),
            repository_url: z.string().optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const CodexEventMsgSchema = z
  .object({
    timestamp: z.string(),
    type: z.literal('event_msg'),
    payload: z
      .object({
        type: z.string().optional(),
        role: z.string().optional(),
        message: z.string().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const CodexResponseItemSchema = z
  .object({
    timestamp: z.string(),
    type: z.literal('response_item'),
    payload: z
      .object({
        type: z.string().optional(),
        role: z.string().optional(),
        name: z.string().optional(),
        arguments: z.string().optional(),
        call_id: z.string().optional(),
        input: z.string().optional(),
        output: z.unknown().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
        action: z
          .object({
            query: z.string().optional(),
            queries: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const CodexTurnContextSchema = z
  .object({
    timestamp: z.string(),
    type: z.literal('turn_context'),
    payload: z
      .object({
        model: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const CodexMessageSchema = z.discriminatedUnion('type', [
  CodexSessionMetaSchema,
  CodexEventMsgSchema,
  CodexResponseItemSchema,
  CodexTurnContextSchema,
]);

export type CodexSessionMeta = z.infer<typeof CodexSessionMetaSchema>;
export type CodexEventMsg = z.infer<typeof CodexEventMsgSchema>;
export type CodexResponseItem = z.infer<typeof CodexResponseItemSchema>;
export type CodexTurnContext = z.infer<typeof CodexTurnContextSchema>;
export type CodexMessage = z.infer<typeof CodexMessageSchema>;

// ── Copilot ─────────────────────────────────────────────────────────────────

export const CopilotWorkspaceSchema = z
  .object({
    id: z.string(),
    cwd: z.string(),
    git_root: z.string().optional(),
    repository: z.string().optional(),
    branch: z.string().optional(),
    summary: z.string().optional(),
    summary_count: z.number().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const CopilotEventSchema = z
  .object({
    type: z.string(),
    id: z.string(),
    timestamp: z.string(),
    parentId: z.union([z.string(), z.null()]).optional(),
    data: z
      .object({
        sessionId: z.string().optional(),
        selectedModel: z.string().optional(),
        content: z.string().optional(),
        transformedContent: z.string().optional(),
        messageId: z.string().optional(),
        toolRequests: z
          .array(
            z
              .object({
                name: z.string(),
                arguments: z.record(z.string(), z.unknown()).optional(),
              })
              .passthrough(),
          )
          .optional(),
        context: z
          .object({
            cwd: z.string().optional(),
            gitRoot: z.string().optional(),
            branch: z.string().optional(),
            repository: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type CopilotWorkspace = z.infer<typeof CopilotWorkspaceSchema>;
export type CopilotEvent = z.infer<typeof CopilotEventSchema>;

// ── Gemini ──────────────────────────────────────────────────────────────────

export const GeminiToolCallSchema = z
  .object({
    name: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
    result: z
      .array(
        z
          .object({
            functionResponse: z
              .object({
                response: z
                  .object({
                    output: z.string().optional(),
                  })
                  .passthrough()
                  .optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    status: z.string().optional(),
    resultDisplay: z
      .object({
        fileName: z.string().optional(),
        filePath: z.string().optional(),
        fileDiff: z.string().optional(),
        originalContent: z.string().optional(),
        newContent: z.string().optional(),
        diffStat: z
          .object({
            model_added_lines: z.number().optional(),
            model_removed_lines: z.number().optional(),
          })
          .passthrough()
          .optional(),
        isNewFile: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const GeminiThoughtSchema = z
  .object({
    subject: z.string().optional(),
    description: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

export const GeminiMessageSchema = z
  .object({
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    content: z.union([
      z.string(),
      z.array(z.object({ text: z.string().optional(), type: z.string().optional() }).passthrough()),
    ]),
    toolCalls: z.array(GeminiToolCallSchema).optional(),
    thoughts: z.array(GeminiThoughtSchema).optional(),
    model: z.string().optional(),
    tokens: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cached: z.number().optional(),
        thoughts: z.number().optional(),
        tool: z.number().optional(),
        total: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const GeminiSessionSchema = z
  .object({
    sessionId: z.string(),
    projectHash: z.string(),
    startTime: z.string(),
    lastUpdated: z.string(),
    messages: z.array(GeminiMessageSchema),
  })
  .passthrough();

export type GeminiToolCall = z.infer<typeof GeminiToolCallSchema>;
export type GeminiThought = z.infer<typeof GeminiThoughtSchema>;
export type GeminiMessage = z.infer<typeof GeminiMessageSchema>;
export type GeminiSession = z.infer<typeof GeminiSessionSchema>;

// ── OpenCode ────────────────────────────────────────────────────────────────

export const OpenCodeSessionSchema = z
  .object({
    id: z.string(),
    slug: z.string().optional(),
    version: z.string().optional(),
    projectID: z.string(),
    directory: z.string(),
    title: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
    }),
    summary: z
      .object({
        additions: z.number().optional(),
        deletions: z.number().optional(),
        files: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

export const OpenCodeProjectSchema = z
  .object({
    id: z.string(),
    worktree: z.string(),
    vcs: z.string().optional(),
    time: z
      .object({
        created: z.number(),
        updated: z.number(),
      })
      .optional(),
  })
  .passthrough();

export const OpenCodeMessageSchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    role: z.enum(['user', 'assistant']),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    summary: z.object({ title: z.string().optional() }).optional(),
    path: z.object({ cwd: z.string().optional(), root: z.string().optional() }).optional(),
  })
  .passthrough();

export const OpenCodePartSchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

// SQLite row schemas
export const SqliteSessionRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  slug: z.string(),
  directory: z.string(),
  title: z.string(),
  version: z.string(),
  summary_additions: z.number().nullable(),
  summary_deletions: z.number().nullable(),
  summary_files: z.number().nullable(),
  time_created: z.number(),
  time_updated: z.number(),
});

export const SqliteMessageRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  time_created: z.number(),
  data: z.string(),
});

export const SqlitePartRowSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  session_id: z.string(),
  time_created: z.number(),
  data: z.string(),
});

export const SqliteProjectRowSchema = z.object({
  id: z.string(),
  worktree: z.string(),
});

export type OpenCodeSession = z.infer<typeof OpenCodeSessionSchema>;
export type OpenCodeProject = z.infer<typeof OpenCodeProjectSchema>;
export type OpenCodeMessage = z.infer<typeof OpenCodeMessageSchema>;
export type OpenCodePart = z.infer<typeof OpenCodePartSchema>;
export type SqliteSessionRow = z.infer<typeof SqliteSessionRowSchema>;
export type SqliteMessageRow = z.infer<typeof SqliteMessageRowSchema>;
export type SqlitePartRow = z.infer<typeof SqlitePartRowSchema>;
export type SqliteProjectRow = z.infer<typeof SqliteProjectRowSchema>;

// ── Droid ───────────────────────────────────────────────────────────────────

export const DroidSessionStartSchema = z
  .object({
    type: z.literal('session_start'),
    id: z.string(),
    title: z.string(),
    sessionTitle: z.string(),
    owner: z.string().optional(),
    version: z.number().optional(),
    cwd: z.string(),
    isSessionTitleManuallySet: z.boolean().optional(),
    sessionTitleAutoStage: z.string().optional(),
  })
  .passthrough();

export const DroidMessageEventSchema = z
  .object({
    type: z.literal('message'),
    id: z.string(),
    timestamp: z.string(),
    parentId: z.string().optional(),
    message: z.object({
      role: z.enum(['user', 'assistant']),
      content: z.array(
        ContentBlockSchema.or(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
      ),
    }),
  })
  .passthrough();

export const DroidTodoStateSchema = z
  .object({
    type: z.literal('todo_state'),
    id: z.string(),
    timestamp: z.string(),
    todos: z.union([z.object({ todos: z.string() }).passthrough(), z.string()]),
    messageIndex: z.number().optional(),
  })
  .passthrough();

export const DroidCompactionStateSchema = z
  .object({
    type: z.literal('compaction_state'),
    id: z.string(),
    timestamp: z.string(),
    summaryText: z.string().optional(),
    summaryTokens: z.number().optional(),
    summaryKind: z.string().optional(),
    anchorMessage: z.string().optional(),
    removedCount: z.number().optional(),
    systemInfo: z.unknown().optional(),
  })
  .passthrough();

export const DroidEventSchema = z.discriminatedUnion('type', [
  DroidSessionStartSchema,
  DroidMessageEventSchema,
  DroidTodoStateSchema,
  DroidCompactionStateSchema,
]);

export const DroidSettingsSchema = z
  .object({
    assistantActiveTimeMs: z.number().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    interactionMode: z.string().optional(),
    autonomyMode: z.string().optional(),
    providerLock: z.string().optional(),
    providerLockTimestamp: z.string().optional(),
    apiProviderLock: z.string().optional(),
    specModeReasoningEffort: z.string().optional(),
    tokenUsage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cacheCreationTokens: z.number().optional(),
        cacheReadTokens: z.number().optional(),
        thinkingTokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type DroidSessionStart = z.infer<typeof DroidSessionStartSchema>;
export type DroidMessageEvent = z.infer<typeof DroidMessageEventSchema>;
export type DroidTodoState = z.infer<typeof DroidTodoStateSchema>;
export type DroidCompactionState = z.infer<typeof DroidCompactionStateSchema>;
export type DroidEvent = z.infer<typeof DroidEventSchema>;
export type DroidSettings = z.infer<typeof DroidSettingsSchema>;

// ── Cursor ──────────────────────────────────────────────────────────────────

export const CursorTranscriptLineSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    message: z.object({
      content: z.array(
        ContentBlockSchema.or(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
      ),
    }),
  })
  .passthrough();

export type CursorTranscriptLine = z.infer<typeof CursorTranscriptLineSchema>;

// ── Serialized Session (Index JSONL) ────────────────────────────────────────

export const SerializedSessionSchema = z.object({
  id: z.string(),
  source: z.enum(TOOL_NAMES),
  cwd: z.string(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  summary: z.string().optional(),
  lines: z.number(),
  bytes: z.number(),
  createdAt: z.string().transform((s) => new Date(s)),
  updatedAt: z.string().transform((s) => new Date(s)),
  originalPath: z.string(),
  model: z.string().optional(),
});

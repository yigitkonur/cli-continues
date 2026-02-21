/**
 * Shared content block types for Anthropic-style message formats.
 * Used by Claude, Droid, and Cursor parsers — all share the same
 * text / thinking / tool_use / tool_result content block structure.
 */
import { z } from 'zod';

// ── Zod Schemas ─────────────────────────────────────────────────────────────

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  text: z.string().optional(),
  thinking: z.string().optional(),
});

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
  is_error: z.boolean().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

// ── TypeScript Types ────────────────────────────────────────────────────────

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

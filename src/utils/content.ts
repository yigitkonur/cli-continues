/**
 * Shared content extraction utilities.
 * Used across parsers that handle Anthropic-style messages with
 * string | Array<{ type, text }> content formats.
 */

/**
 * Extract text from message content that can be a string or an array of blocks.
 * Filters to text blocks and joins with newlines.
 */
export function extractTextFromBlocks(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;

  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}

/**
 * Check whether a text block contains system-injected content
 * that should be excluded from handoff context.
 * Common across Claude, Droid, Cursor, and Codex parsers.
 */
export function isSystemContent(text: string): boolean {
  return (
    text.startsWith('<system-reminder>') ||
    text.startsWith('<permissions') ||
    text.startsWith('<environment_context>') ||
    text.startsWith('<external_links>') ||
    text.startsWith('<image_files>') ||
    text.startsWith('# AGENTS.md')
  );
}

/**
 * Check whether a user message is "real" user input vs meta/system content.
 * Filters out command-like messages, XML tags, and handoff summaries.
 */
export function isRealUserMessage(text: string): boolean {
  if (!text) return false;
  return !text.startsWith('<') && !text.startsWith('/') && !text.includes('Session Handoff');
}

/**
 * Extract repo identifier from a git remote URL.
 * Handles HTTPS (github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
 * Returns 'owner/repo' or empty string.
 */
export function extractRepoFromGitUrl(gitUrl: string): string {
  if (!gitUrl) return '';
  const match = gitUrl.match(/[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : '';
}

/**
 * Extract clean user text from Cursor's <user_query> tags.
 * Returns inner text if tags are present, otherwise returns the original text.
 */
export function cleanUserQueryText(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return match ? match[1].trim() : text;
}

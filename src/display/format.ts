import chalk from 'chalk';
import { adapters } from '../parsers/registry.js';
import type { SessionSource, UnifiedSession } from '../types/index.js';

/**
 * Source-specific colors for consistent branding -- derived from the adapter registry
 */
export const sourceColors = Object.fromEntries(Object.values(adapters).map((a) => [a.name, a.color])) as Record<
  SessionSource,
  (s: string) => string
>;

/**
 * Format session with colors in columnar layout
 * Format: [source]  YYYY-MM-DD HH:MM  project-name  summary...  short-id
 */
export function formatSessionColored(session: UnifiedSession): string {
  const colorFn = sourceColors[session.source] || chalk.white;
  const tag = `[${session.source}]`;
  const source = colorFn(tag.padEnd(10));

  const date = chalk.gray(session.updatedAt.toISOString().slice(0, 16).replace('T', ' '));

  // Show repo or last folder of cwd
  const repoDisplay = session.repo || session.cwd.split('/').slice(-2).join('/') || '';
  const repo = chalk.cyan(repoDisplay.slice(0, 20).padEnd(20));

  // Summary - truncate nicely
  const summaryText = session.summary || '(no summary)';
  const summary = (session.summary ? chalk.white(summaryText.slice(0, 44)) : chalk.gray(summaryText)).padEnd(44);

  // Short ID
  const id = chalk.gray(session.id.slice(0, 8));

  return `${source} ${date}  ${repo}  ${summary}  ${id}`;
}

/**
 * Format session for clack select - simpler, cleaner
 */
export function formatSessionForSelect(session: UnifiedSession): string {
  const colorFn = sourceColors[session.source] || chalk.white;
  const tag = `[${session.source}]`;
  const source = colorFn(tag.padEnd(10));
  const date = session.updatedAt.toISOString().slice(0, 16).replace('T', ' ');
  const repoDisplay = session.repo || session.cwd.split('/').slice(-1)[0] || '';
  const summary = (session.summary || '(no summary)').slice(0, 48);

  return `${source}  ${date}  ${chalk.cyan(repoDisplay.padEnd(20))}  ${summary}`;
}

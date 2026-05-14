import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { type ContinuesSession, type PresetName, type ResumeTarget } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const PRESETS = new Set<PresetName>(['minimal', 'standard', 'verbose', 'full']);

interface CliExecutionResult {
  stdout: string;
  stderr: string;
}

interface ExecFileError extends Error {
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

function isExecFileError(error: unknown): error is ExecFileError {
  return error instanceof Error && ('code' in error || 'stderr' in error || 'stdout' in error);
}

function readConfiguration(): { cliPath: string; preset: PresetName } {
  const config = vscode.workspace.getConfiguration('continuesRelay');
  const cliPath = config.get<string>('cliPath', 'continues').trim() || 'continues';
  const presetValue = config.get<string>('preset', 'standard');
  const preset = PRESETS.has(presetValue as PresetName) ? (presetValue as PresetName) : 'standard';
  return { cliPath, preset };
}

function normalizeSession(raw: unknown): ContinuesSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.source !== 'string') return null;

  return {
    id: record.id,
    source: record.source,
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    repo: typeof record.repo === 'string' ? record.repo : undefined,
    branch: typeof record.branch === 'string' ? record.branch : undefined,
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    lines: typeof record.lines === 'number' ? record.lines : 0,
    bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    createdAt: typeof record.createdAt === 'string' ? new Date(record.createdAt) : new Date(0),
    updatedAt: typeof record.updatedAt === 'string' ? new Date(record.updatedAt) : new Date(0),
    originalPath: typeof record.originalPath === 'string' ? record.originalPath : '',
    model: typeof record.model === 'string' ? record.model : undefined,
  };
}

function parseJsonArray(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    }
    throw error;
  }
}

function shouldRunThroughCmd(cliPath: string): boolean {
  if (process.platform !== 'win32') return false;
  const extension = path.extname(cliPath).toLowerCase();
  return extension === '' || extension === '.cmd' || extension === '.bat';
}

function terminalQuote(arg: string): string {
  if (/^[A-Za-z0-9._:/\\=@-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

function formatError(error: unknown): Error {
  if (!isExecFileError(error)) return new Error(String(error));
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : '';
  const details = stderr || stdout || error.message;
  return new Error(details);
}

export class ContinuesCli {
  get cliPath(): string {
    return readConfiguration().cliPath;
  }

  get preset(): PresetName {
    return readConfiguration().preset;
  }

  async listSessions(rebuild: boolean): Promise<ContinuesSession[]> {
    const args = ['list', '--json', '--limit', '80'];
    if (rebuild) args.push('--rebuild');

    const { stdout } = await this.execCli(args);
    return parseJsonArray(stdout)
      .map((item) => normalizeSession(item))
      .filter((session): session is ContinuesSession => session !== null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async previewHandoff(session: ContinuesSession, storageDirectory: string): Promise<string> {
    await fs.mkdir(storageDirectory, { recursive: true });
    const safeId = session.id.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
    const handoffPath = path.join(storageDirectory, `handoff-${session.source}-${safeId}.md`);
    await this.execCli(['--preset', this.preset, 'inspect', session.id, '--write-md', handoffPath], {
      cwd: session.cwd || undefined,
    });
    return handoffPath;
  }

  buildResumeCommand(session: Pick<ContinuesSession, 'id'>, target: ResumeTarget): string {
    const args = [this.cliPath, '--preset', this.preset, 'resume', session.id, '--in', target];
    return args.map(terminalQuote).join(' ');
  }

  buildPreviewCommand(session: Pick<ContinuesSession, 'id'>): string {
    const args = [this.cliPath, '--preset', this.preset, 'inspect', session.id, '--write-md', '<handoff.md>'];
    return args.map(terminalQuote).join(' ');
  }

  private async execCli(args: string[], options: { cwd?: string } = {}): Promise<CliExecutionResult> {
    const { cliPath } = readConfiguration();
    const env = {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    };

    try {
      const result = shouldRunThroughCmd(cliPath)
        ? await execFileAsync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cliPath, ...args], {
            cwd: options.cwd,
            env,
            maxBuffer: MAX_BUFFER_BYTES,
            windowsHide: true,
          })
        : await execFileAsync(cliPath, args, {
            cwd: options.cwd,
            env,
            maxBuffer: MAX_BUFFER_BYTES,
            windowsHide: true,
          });

      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      throw formatError(error);
    }
  }
}

export const SUPPORTED_SESSION_SOURCES = [
  'claude',
  'codex',
  'copilot',
  'gemini',
  'opencode',
  'droid',
  'cursor',
  'amp',
  'kiro',
  'crush',
  'cline',
  'roo-code',
  'kilo-code',
  'antigravity',
  'kimi',
  'qwen-code',
] as const;

export type SupportedSessionSource = (typeof SUPPORTED_SESSION_SOURCES)[number];
export type ResumeTarget = 'codex' | 'claude';
export type PresetName = 'minimal' | 'standard' | 'verbose' | 'full';
export type Locale = 'en' | 'zh-CN';
export type LanguagePreference = 'auto' | Locale;

export interface ContinuesSession {
  id: string;
  source: string;
  cwd: string;
  repo?: string;
  branch?: string;
  summary?: string;
  lines: number;
  bytes: number;
  createdAt: Date;
  updatedAt: Date;
  originalPath: string;
  model?: string;
}

export interface SessionViewModel {
  id: string;
  shortId: string;
  source: string;
  sourceLabel: string;
  cwd: string;
  repo: string;
  branch: string;
  summary: string;
  updatedAt: string;
  relativeUpdated: string;
  model: string;
  command: string;
  isSelected: boolean;
}

export interface RelayViewState {
  sessions: SessionViewModel[];
  selected?: SessionViewModel;
  loading: boolean;
  error?: string;
  cliPath: string;
  preset: PresetName;
  languagePreference: LanguagePreference;
  locale: Locale;
  commandPreview: string;
}

export type WebviewMessage =
  | { type: 'refresh' }
  | { type: 'selectSession'; id: string }
  | { type: 'previewHandoff' }
  | { type: 'resumeInCodex' }
  | { type: 'resumeInClaude' }
  | { type: 'copySessionId' }
  | { type: 'copyCliCommand' }
  | { type: 'setLanguage'; language: Locale };

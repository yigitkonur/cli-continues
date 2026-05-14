import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContinuesCli } from './ContinuesCli.js';
import type {
  ContinuesSession,
  LanguagePreference,
  Locale,
  RelayViewState,
  ResumeTarget,
  SessionViewModel,
  WebviewMessage,
} from './types.js';

const SOURCE_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  droid: 'Droid',
  cursor: 'Cursor',
  amp: 'Amp',
  kiro: 'Kiro',
  crush: 'Crush',
  cline: 'Cline',
  'roo-code': 'Roo',
  'kilo-code': 'Kilo',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  'qwen-code': 'Qwen',
};

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let index = 0; index < 32; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}

function getLanguagePreference(): LanguagePreference {
  const value = vscode.workspace.getConfiguration('continuesRelay').get<string>('language', 'auto');
  if (value === 'en' || value === 'zh-CN') return value;
  return 'auto';
}

function resolveLocale(preference: LanguagePreference): Locale {
  if (preference !== 'auto') return preference;
  return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function formatRelativeTime(date: Date, locale: Locale): string {
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return locale === 'zh-CN' ? '刚刚' : 'just now';

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return locale === 'zh-CN' ? '刚刚' : 'just now';
  if (diffMs < hour) {
    const value = Math.max(1, Math.floor(diffMs / minute));
    return locale === 'zh-CN' ? `${value} 分钟前` : `${value}m ago`;
  }
  if (diffMs < day) {
    const value = Math.floor(diffMs / hour);
    return locale === 'zh-CN' ? `${value} 小时前` : `${value}h ago`;
  }
  const value = Math.floor(diffMs / day);
  return locale === 'zh-CN' ? `${value} 天前` : `${value}d ago`;
}

function compactPath(cwd: string, locale: Locale): string {
  if (!cwd) return locale === 'zh-CN' ? '未知工作区' : 'Unknown workspace';
  const normalized = cwd.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() ?? normalized;
}

export class ContinuesViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'continuesRelay.sessionsView';

  private view?: vscode.WebviewView;
  private sessions: ContinuesSession[] = [];
  private selectedId?: string;
  private loading = false;
  private error?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cli: ContinuesCli,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const nonce = getNonce();

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview, nonce, this.createState());
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        void this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions,
    );

    void this.refreshSessions(false);
  }

  async refreshSessions(rebuild: boolean): Promise<void> {
    this.loading = true;
    this.error = undefined;
    this.postState();

    try {
      this.sessions = await this.cli.listSessions(rebuild);
      if (!this.selectedId || !this.sessions.some((session) => session.id === this.selectedId)) {
        this.selectedId = this.sessions[0]?.id;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.postState();
    }
  }

  refreshConfiguration(): void {
    this.postState();
  }

  async previewSelected(): Promise<void> {
    const session = this.getSelectedSession();
    const locale = resolveLocale(getLanguagePreference());
    if (!session) {
      void vscode.window.showWarningMessage(
        locale === 'zh-CN' ? '还没有选择 Continues 会话。' : 'No Continues session is selected.',
      );
      return;
    }

    try {
      const previewDirectory = path.join(this.context.globalStorageUri.fsPath, 'handoffs');
      const handoffPath = await this.cli.previewHandoff(session, previewDirectory);
      const document = await vscode.workspace.openTextDocument(handoffPath);
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        locale === 'zh-CN' ? `Continues handoff 预览失败：${message}` : `Continues handoff preview failed: ${message}`,
      );
    }
  }

  async resumeSelected(target: ResumeTarget): Promise<void> {
    const session = this.getSelectedSession();
    const locale = resolveLocale(getLanguagePreference());
    if (!session) {
      void vscode.window.showWarningMessage(
        locale === 'zh-CN' ? '还没有选择 Continues 会话。' : 'No Continues session is selected.',
      );
      return;
    }

    const command = this.cli.buildResumeCommand(session, target);
    const terminal = vscode.window.createTerminal({
      name: `Continues: ${target === 'codex' ? 'Codex' : 'Claude'}`,
      cwd: session.cwd || undefined,
    });
    terminal.show();
    terminal.sendText(command, true);
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'refresh':
        await this.refreshSessions(true);
        break;
      case 'selectSession':
        this.selectedId = message.id;
        this.postState();
        break;
      case 'previewHandoff':
        await this.previewSelected();
        break;
      case 'resumeInCodex':
        await this.resumeSelected('codex');
        break;
      case 'resumeInClaude':
        await this.resumeSelected('claude');
        break;
      case 'copySessionId': {
        const session = this.getSelectedSession();
        if (session) await vscode.env.clipboard.writeText(session.id);
        break;
      }
      case 'copyCliCommand': {
        const session = this.getSelectedSession();
        if (session) await vscode.env.clipboard.writeText(this.cli.buildResumeCommand(session, 'codex'));
        break;
      }
      case 'setLanguage':
        await vscode.workspace
          .getConfiguration('continuesRelay')
          .update('language', message.language, vscode.ConfigurationTarget.Global);
        this.postState();
        break;
    }
  }

  private getSelectedSession(): ContinuesSession | undefined {
    return this.sessions.find((session) => session.id === this.selectedId) ?? this.sessions[0];
  }

  private createState(): RelayViewState {
    const languagePreference = getLanguagePreference();
    const locale = resolveLocale(languagePreference);
    const selectedSession = this.getSelectedSession();
    const sessions = this.sessions.map((session) =>
      this.toViewModel(session, session.id === selectedSession?.id, locale),
    );
    const selected = sessions.find((session) => session.isSelected);
    const commandPreview = selectedSession ? this.cli.buildResumeCommand(selectedSession, 'codex') : '';

    return {
      sessions,
      selected,
      loading: this.loading,
      error: this.error,
      cliPath: this.cli.cliPath,
      preset: this.cli.preset,
      languagePreference,
      locale,
      commandPreview,
    };
  }

  private toViewModel(session: ContinuesSession, isSelected: boolean, locale: Locale): SessionViewModel {
    return {
      id: session.id,
      shortId: session.id.slice(0, 12),
      source: session.source,
      sourceLabel: SOURCE_LABELS[session.source] ?? session.source,
      cwd: session.cwd,
      repo: session.repo || compactPath(session.cwd, locale),
      branch: session.branch || (locale === 'zh-CN' ? '未知分支' : 'Unknown branch'),
      summary: session.summary || (locale === 'zh-CN' ? '未命名会话' : 'Untitled session'),
      updatedAt: session.updatedAt.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US'),
      relativeUpdated: formatRelativeTime(session.updatedAt, locale),
      model: session.model || (locale === 'zh-CN' ? '未知模型' : 'Unknown model'),
      command: this.cli.buildResumeCommand(session, 'codex'),
      isSelected,
    };
  }

  private postState(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.createState() });
  }

  private getHtml(webview: vscode.Webview, nonce: string, initialState: RelayViewState): string {
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="${initialState.locale}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Continues Relay</title>
  <style>
    :root {
      --panel-bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
      --panel-fg: var(--vscode-sideBar-foreground, var(--vscode-foreground, #cccccc));
      --panel-strong: var(--vscode-foreground, #ffffff);
      --panel-muted: var(--vscode-descriptionForeground, rgba(204, 204, 204, 0.62));
      --panel-border: var(--vscode-sideBar-border, var(--vscode-widget-border, #3c3c3c));
      --panel-border-soft: var(--vscode-widget-border, rgba(127, 127, 127, 0.3));
      --panel-header: var(--vscode-sideBarTitle-background, var(--panel-bg));
      --input-bg: var(--vscode-input-background, var(--panel-bg));
      --input-fg: var(--vscode-input-foreground, var(--panel-fg));
      --input-placeholder: var(--vscode-input-placeholderForeground, var(--panel-muted));
      --focus: var(--vscode-focusBorder, #007acc);
      --list-hover: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.12));
      --list-active: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground, rgba(0, 122, 204, 0.18)));
      --list-active-fg: var(--vscode-list-activeSelectionForeground, var(--panel-strong));
      --button-bg: var(--vscode-button-background, #0e639c);
      --button-hover: var(--vscode-button-hoverBackground, #1177bb);
      --button-fg: var(--vscode-button-foreground, #ffffff);
      --secondary-button-bg: var(--vscode-button-secondaryBackground, transparent);
      --secondary-button-hover: var(--vscode-button-secondaryHoverBackground, var(--list-hover));
      --secondary-button-fg: var(--vscode-button-secondaryForeground, var(--panel-fg));
      --code-bg: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.1));
      --link: var(--vscode-textLink-foreground, #3794ff);
      --radius: 8px;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      width: 100%;
      min-width: 260px;
      height: 100%;
      margin: 0;
      overflow: hidden;
      color: var(--panel-fg);
      background: var(--panel-bg);
      font-family: var(--vscode-font-family), "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }

    button,
    input {
      font: inherit;
    }

    .panel {
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: var(--panel-bg);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 11px 12px;
      border-bottom: 1px solid var(--panel-border-soft);
      background: var(--panel-header);
    }

    .title {
      overflow: hidden;
      color: var(--panel-muted);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 9px;
    }

    .icon-button {
      display: inline-grid;
      place-items: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      color: var(--panel-muted);
      background: transparent;
      cursor: pointer;
    }

    .icon-button:hover {
      color: var(--panel-strong);
      background: var(--list-hover);
    }

    .language-button {
      width: auto;
      min-width: 34px;
      padding: 0 6px;
      font-size: 10px;
      font-weight: 700;
    }

    .search-area {
      padding: 12px 12px 8px;
    }

    .search-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 32px;
      padding: 0 10px;
      border: 1px solid var(--panel-border);
      border-radius: 4px;
      background: var(--input-bg);
    }

    .search-wrap:focus-within {
      border-color: var(--focus);
    }

    .search-icon {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      color: var(--input-placeholder);
    }

    .search {
      min-width: 0;
      width: 100%;
      border: 0;
      outline: 0;
      color: var(--input-fg);
      background: transparent;
      font-size: 12px;
    }

    .search::placeholder {
      color: var(--input-placeholder);
    }

    .loading-slot {
      padding: 0 12px;
    }

    .scroll {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 8px 12px 18px;
    }

    .scroll::-webkit-scrollbar {
      width: 4px;
    }

    .scroll::-webkit-scrollbar-track {
      background: transparent;
    }

    .scroll::-webkit-scrollbar-thumb {
      border-radius: 10px;
      background: var(--vscode-scrollbarSlider-background, rgba(127, 127, 127, 0.4));
    }

    .group {
      margin-bottom: 20px;
    }

    .section-title {
      margin: 0 0 8px;
      color: var(--panel-muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .section-title.zh {
      text-transform: none;
    }

    .sessions {
      display: grid;
      gap: 6px;
    }

    .sessions-frame {
      height: 246px;
      overflow-y: auto;
      padding-right: 2px;
    }

    .sessions-frame::-webkit-scrollbar {
      width: 4px;
    }

    .sessions-frame::-webkit-scrollbar-track {
      background: transparent;
    }

    .sessions-frame::-webkit-scrollbar-thumb {
      border-radius: 10px;
      background: var(--vscode-scrollbarSlider-background, rgba(127, 127, 127, 0.4));
    }

    .session {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 10px;
      width: 100%;
      min-height: 58px;
      padding: 10px;
      border: 1px solid transparent;
      border-radius: var(--radius);
      color: var(--panel-fg);
      background: transparent;
      text-align: left;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }

    .session:hover,
    .session.selected {
      background: var(--list-hover);
    }

    .session.selected {
      border-color: var(--focus);
      color: var(--list-active-fg);
      background: var(--list-active);
    }

    .source-dot {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border: 1px solid var(--panel-border);
      border-radius: 50%;
      color: var(--panel-muted);
      background: var(--input-bg);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }

    .session.selected .source-dot {
      border-color: var(--focus);
    }

    .session-main {
      min-width: 0;
    }

    .session-top,
    .session-sub {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    .summary,
    .repo-line {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .summary {
      color: var(--panel-strong);
      font-size: 12.5px;
      font-weight: 600;
    }

    .repo-line,
    .session-time {
      color: var(--panel-muted);
      font-size: 10px;
    }

    .session-time {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 46px;
      max-width: 74px;
      padding: 1px 6px;
      border-radius: 5px;
      color: var(--panel-fg);
      background: var(--list-hover);
      font-size: 9px;
      font-weight: 800;
      line-height: 16px;
      text-transform: none;
      white-space: nowrap;
    }

    .tag-claude { color: #ffad7d; background: #4a342a; }
    .tag-codex { color: #7fc1ff; background: #23354d; }
    .tag-copilot { color: #8fd3ff; background: #173c4f; }
    .tag-gemini { color: #b8c7ff; background: #30375d; }
    .tag-opencode { color: #9ae6b4; background: #204230; }
    .tag-droid { color: #b4f58b; background: #2f451f; }
    .tag-cursor { color: #dedede; background: #3c3c3c; }
    .tag-amp { color: #f8d17d; background: #4b391a; }
    .tag-kiro { color: #ffb4d0; background: #4a2635; }
    .tag-crush { color: #ffadad; background: #4a2a2a; }
    .tag-cline { color: #7ff0c9; background: #1d4037; }
    .tag-roo-code { color: #c5b8ff; background: #342e58; }
    .tag-kilo-code { color: #c3f3ff; background: #213d47; }
    .tag-antigravity { color: #d6c5ff; background: #342d4a; }
    .tag-kimi { color: #ffe1a3; background: #4a3a20; }
    .tag-qwen-code { color: #b5d5ff; background: #24364f; }

    .detail-card {
      overflow: hidden;
      border: 1px solid var(--panel-border);
      border-radius: 10px;
      background: var(--input-bg);
    }

    .detail-body {
      display: grid;
      gap: 9px;
      padding: 13px;
      font-size: 11.5px;
    }

    .kv {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-height: 18px;
    }

    .k {
      flex: 0 0 auto;
      color: var(--panel-muted);
    }

    .v {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      color: var(--panel-strong);
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .accent {
      color: var(--link);
      font-weight: 650;
    }

    .copy-mini {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      border: 0;
      color: var(--panel-muted);
      background: transparent;
      cursor: pointer;
    }

    .copy-mini:hover {
      color: var(--panel-strong);
    }

    .actions {
      display: grid;
      gap: 8px;
      margin-bottom: 20px;
    }

    .action {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      min-height: 31px;
      padding: 5px 10px;
      border: 1px solid var(--panel-border);
      border-radius: 3px;
      color: var(--secondary-button-fg);
      background: var(--secondary-button-bg);
      font-size: 12px;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }

    .action:hover {
      background: var(--secondary-button-hover);
    }

    .action.primary {
      border-color: transparent;
      background: var(--button-bg);
      color: var(--button-fg);
    }

    .action.primary:hover {
      background: var(--button-hover);
    }

    .action.warm {
      border-color: transparent;
      background: #d97706;
      color: #fff;
    }

    .action.warm:hover {
      background: #f59e0b;
    }

    .command-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      color: var(--panel-muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0;
    }

    .command-box {
      overflow: hidden;
      padding: 11px;
      border: 1px solid var(--panel-border-soft);
      border-radius: 8px;
      background: var(--code-bg);
    }

    code {
      display: block;
      overflow: hidden;
      color: var(--panel-muted);
      font-family: var(--vscode-editor-font-family), "JetBrains Mono", Consolas, monospace;
      font-size: 10px;
      line-height: 1.6;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .cmd-session {
      color: #ec4899;
    }

    .cmd-preset {
      color: #10b981;
    }

    .empty,
    .error {
      padding: 11px;
      border: 1px solid var(--panel-border-soft);
      border-radius: var(--radius);
      color: var(--panel-muted);
      background: var(--input-bg);
      font-size: 12px;
    }

    .error {
      margin: 0 12px 8px;
      border-color: rgba(255, 101, 101, 0.45);
      color: #ffb4b4;
    }

    .spinner {
      height: 2px;
      overflow: hidden;
      border-radius: 99px;
      background: rgba(0, 122, 204, 0.18);
    }

    .spinner::after {
      content: "";
      display: block;
      width: 36%;
      height: 100%;
      background: linear-gradient(90deg, transparent, var(--focus), transparent);
      animation: relay-load 1s infinite;
    }

    .sprite {
      display: none;
    }

    .icon {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .icon-button .icon,
    .copy-mini .icon {
      width: 13px;
      height: 13px;
    }

    .source-dot .icon {
      width: 13px;
      height: 13px;
    }

    @keyframes relay-load {
      from { transform: translateX(-100%); }
      to { transform: translateX(280%); }
    }
  </style>
</head>
<body>
  <svg class="sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <symbol id="i-search" viewBox="0 0 24 24">
      <path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" />
      <path d="M21 21l-6 -6" />
    </symbol>
    <symbol id="i-refresh" viewBox="0 0 24 24">
      <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
    </symbol>
    <symbol id="i-dots" viewBox="0 0 24 24">
      <path d="M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
    </symbol>
    <symbol id="i-terminal" viewBox="0 0 24 24">
      <path d="M5 7l5 5l-5 5" />
      <path d="M12 19l7 0" />
    </symbol>
    <symbol id="i-wand" viewBox="0 0 24 24">
      <path d="M6 21l15 -15l-3 -3l-15 15l3 3" />
      <path d="M15 6l3 3" />
      <path d="M9 3a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2" />
      <path d="M19 13a2 2 0 0 0 2 2a2 2 0 0 0 -2 2a2 2 0 0 0 -2 -2a2 2 0 0 0 2 -2" />
    </symbol>
    <symbol id="i-eye" viewBox="0 0 24 24">
      <path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" />
      <path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6" />
    </symbol>
    <symbol id="i-copy" viewBox="0 0 24 24">
      <path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666" />
      <path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" />
    </symbol>
    <symbol id="i-folder-open" viewBox="0 0 24 24">
      <path d="M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2" />
    </symbol>
    <symbol id="i-git-branch" viewBox="0 0 24 24">
      <path d="M5 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M5 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M15 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M7 8l0 8" />
      <path d="M9 18h6a2 2 0 0 0 2 -2v-5" />
      <path d="M14 14l3 -3l3 3" />
    </symbol>
    <symbol id="i-circle-dot" viewBox="0 0 24 24">
      <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0" />
    </symbol>
    <symbol id="i-code" viewBox="0 0 24 24">
      <path d="M7 8l-4 4l4 4" />
      <path d="M17 8l4 4l-4 4" />
      <path d="M14 4l-4 16" />
    </symbol>
  </svg>
  <main class="panel">
    <header class="header">
      <div class="title">Continues Relay</div>
      <div class="header-actions">
        <button class="icon-button language-button" id="language-toggle" title="Switch language" aria-label="Switch language">中/EN</button>
        <button class="icon-button" id="refresh" title="Refresh sessions" aria-label="Refresh sessions"><svg class="icon" aria-hidden="true"><use href="#i-refresh"></use></svg></button>
        <span class="icon-button" aria-hidden="true"><svg class="icon"><use href="#i-dots"></use></svg></span>
      </div>
    </header>

    <div class="search-area">
      <div class="search-wrap">
        <svg class="icon search-icon" aria-hidden="true"><use href="#i-search"></use></svg>
        <input class="search" id="search" type="search" placeholder="Search sessions..." aria-label="Search sessions">
      </div>
    </div>

    <div class="loading-slot" id="loading"></div>
    <div id="error"></div>

    <div class="scroll">
      <section class="group">
        <h2 class="section-title" id="recent-title">Recent Sessions</h2>
        <div class="sessions-frame">
          <div class="sessions" id="sessions"></div>
        </div>
      </section>

      <section id="detail"></section>
    </div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${JSON.stringify(initialState)};
    let searchQuery = '';

    const sessionsEl = document.getElementById('sessions');
    const detailEl = document.getElementById('detail');
    const errorEl = document.getElementById('error');
    const loadingEl = document.getElementById('loading');
    const searchEl = document.getElementById('search');
    const languageToggleEl = document.getElementById('language-toggle');
    const recentTitleEl = document.getElementById('recent-title');

    const translations = {
      en: {
        refresh: 'Refresh sessions',
        switchLanguage: 'Switch to Chinese',
        searchPlaceholder: 'Search sessions...',
        searchLabel: 'Search sessions',
        recentSessions: 'Recent Sessions',
        noMatchingSessions: 'No matching sessions.',
        noSession: 'Select a session to preview a handoff or resume in Codex / Claude.',
        selectedSession: 'Selected Session',
        source: 'Source',
        repo: 'Repo',
        branch: 'Branch',
        preset: 'Preset',
        sessionId: 'Session ID',
        copySessionId: 'Copy session ID',
        preview: 'Preview Handoff',
        resumeCodex: 'Resume in Codex',
        resumeClaude: 'Resume in Claude',
        cliCommand: 'CLI Command',
        copyCommand: 'Copy CLI command',
        loading: 'Loading sessions',
        languageBadge: '中文'
      },
      'zh-CN': {
        refresh: '刷新会话',
        switchLanguage: '切换到英文',
        searchPlaceholder: '搜索会话...',
        searchLabel: '搜索会话',
        recentSessions: '最近会话',
        noMatchingSessions: '没有匹配的会话。',
        noSession: '选择一个会话后，可以预览 handoff 或接力到 Codex / Claude。',
        selectedSession: '已选会话',
        source: '来源',
        repo: '仓库',
        branch: '分支',
        preset: '预设',
        sessionId: '会话 ID',
        copySessionId: '复制会话 ID',
        preview: '预览交接',
        resumeCodex: '接力到 Codex',
        resumeClaude: '接力到 Claude',
        cliCommand: 'CLI 命令',
        copyCommand: '复制 CLI 命令',
        loading: '正在加载会话',
        languageBadge: 'EN'
      }
    };

    function t(key) {
      return translations[state.locale]?.[key] ?? translations.en[key] ?? key;
    }

    function applyLocale() {
      document.documentElement.lang = state.locale;
      document.getElementById('refresh').title = t('refresh');
      document.getElementById('refresh').setAttribute('aria-label', t('refresh'));
      languageToggleEl.textContent = t('languageBadge');
      languageToggleEl.title = t('switchLanguage');
      languageToggleEl.setAttribute('aria-label', t('switchLanguage'));
      searchEl.placeholder = t('searchPlaceholder');
      searchEl.setAttribute('aria-label', t('searchLabel'));
      recentTitleEl.textContent = t('recentSessions');
    }

    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    languageToggleEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'setLanguage', language: state.locale === 'zh-CN' ? 'en' : 'zh-CN' });
    });

    searchEl.addEventListener('input', () => {
      searchQuery = searchEl.value.trim().toLowerCase();
      renderSessions();
    });

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'state') {
        state = event.data.state;
        render();
      }
    });

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function tagClass(session) {
      return 'tag-' + escapeHtml(session.source);
    }

    function icon(name) {
      return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
    }

    function sourceIcon(session) {
      if (session.source === 'claude') return 'wand';
      if (session.source === 'codex') return 'terminal';
      if (session.source === 'cursor') return 'code';
      if (session.source === 'cline') return 'terminal';
      if (session.source === 'gemini') return 'wand';
      if (session.source === 'opencode') return 'terminal';
      if (session.source === 'droid') return 'terminal';
      if (session.source === 'copilot') return 'code';
      return 'code';
    }

    function matchesQuery(session) {
      if (!searchQuery) return true;
      const haystack = [
        session.summary,
        session.repo,
        session.branch,
        session.sourceLabel,
        session.shortId,
        session.cwd,
        state.preset
      ].join(' ').toLowerCase();
      return haystack.includes(searchQuery);
    }

    function renderCommandLine() {
      if (!state.commandPreview) return '';
      let command = escapeHtml(state.commandPreview);
      if (state.selected?.id) {
        command = command.replace(escapeHtml(state.selected.id), '<span class="cmd-session">' + escapeHtml(state.selected.id) + '</span>');
      }
      command = command.replace(escapeHtml(state.preset), '<span class="cmd-preset">' + escapeHtml(state.preset) + '</span>');
      return command;
    }

    function renderSessions() {
      const visible = state.sessions.filter(matchesQuery);
      if (visible.length === 0) {
        sessionsEl.innerHTML = '<div class="empty">' + escapeHtml(t('noMatchingSessions')) + '</div>';
        return;
      }

      sessionsEl.innerHTML = visible.map((session) => {
        return \`
          <button class="session \${session.isSelected ? 'selected' : ''}" data-id="\${escapeHtml(session.id)}">
            <span class="source-dot">\${icon(sourceIcon(session))}</span>
            <span class="session-main">
              <span class="session-top">
                <span class="summary" title="\${escapeHtml(session.summary)}">\${escapeHtml(session.summary)}</span>
                <span class="badge \${tagClass(session)}">\${escapeHtml(session.sourceLabel)}</span>
              </span>
              <span class="session-sub">
                <span class="repo-line" title="\${escapeHtml(session.cwd)}">\${escapeHtml(session.repo)}</span>
                <span class="session-time">\${escapeHtml(session.relativeUpdated)}</span>
              </span>
            </span>
          </button>
        \`;
      }).join('');

      for (const node of sessionsEl.querySelectorAll('.session')) {
        node.addEventListener('click', () => {
          vscode.postMessage({ type: 'selectSession', id: node.dataset.id });
        });
      }
    }

    function renderDetail() {
      const selected = state.selected;
      if (!selected) {
        detailEl.innerHTML = '<div class="empty">' + escapeHtml(t('noSession')) + '</div>';
        return;
      }

      detailEl.innerHTML = \`
        <section class="group">
          <h2 class="section-title">\${escapeHtml(t('selectedSession'))}</h2>
          <div class="detail-card">
            <div class="detail-body">
              <div class="kv"><span class="k">\${escapeHtml(t('source'))}</span><span class="v"><span class="badge \${tagClass(selected)}">\${escapeHtml(selected.sourceLabel)}</span></span></div>
              <div class="kv"><span class="k">\${escapeHtml(t('repo'))}</span><span class="v" title="\${escapeHtml(selected.cwd)}">\${icon('folder-open')}\${escapeHtml(selected.repo)}</span></div>
              <div class="kv"><span class="k">\${escapeHtml(t('branch'))}</span><span class="v accent">\${icon('git-branch')}\${escapeHtml(selected.branch)}</span></div>
              <div class="kv"><span class="k">\${escapeHtml(t('preset'))}</span><span class="v">\${escapeHtml(state.preset)}</span></div>
              <div class="kv">
                <span class="k">\${escapeHtml(t('sessionId'))}</span>
                <span class="v">
                  \${icon('circle-dot')}
                  <span title="\${escapeHtml(selected.id)}">\${escapeHtml(selected.shortId)}</span>
                  <button class="copy-mini" id="copy-session" title="\${escapeHtml(t('copySessionId'))}" aria-label="\${escapeHtml(t('copySessionId'))}">\${icon('copy')}</button>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section class="actions">
          <button class="action" id="preview">\${icon('eye')}\${escapeHtml(t('preview'))}</button>
          <button class="action primary" id="codex">\${icon('terminal')}\${escapeHtml(t('resumeCodex'))}</button>
          <button class="action warm" id="claude">\${icon('wand')}\${escapeHtml(t('resumeClaude'))}</button>
        </section>

        <section class="group">
          <div class="command-head">
            <span>\${escapeHtml(t('cliCommand'))}</span>
            <button class="copy-mini" id="copy-command" title="\${escapeHtml(t('copyCommand'))}" aria-label="\${escapeHtml(t('copyCommand'))}">\${icon('copy')}</button>
          </div>
          <div class="command-box">
            <code title="\${escapeHtml(state.commandPreview)}">\${renderCommandLine()}</code>
          </div>
        </section>
      \`;

      document.getElementById('preview').addEventListener('click', () => vscode.postMessage({ type: 'previewHandoff' }));
      document.getElementById('codex').addEventListener('click', () => vscode.postMessage({ type: 'resumeInCodex' }));
      document.getElementById('claude').addEventListener('click', () => vscode.postMessage({ type: 'resumeInClaude' }));
      document.getElementById('copy-session').addEventListener('click', () => vscode.postMessage({ type: 'copySessionId' }));
      document.getElementById('copy-command').addEventListener('click', () => vscode.postMessage({ type: 'copyCliCommand' }));
    }

    function render() {
      applyLocale();
      loadingEl.innerHTML = state.loading ? '<div class="spinner" aria-label="' + escapeHtml(t('loading')) + '"></div>' : '';
      errorEl.innerHTML = state.error ? '<div class="error">' + escapeHtml(state.error) + '</div>' : '';
      renderSessions();
      renderDetail();
    }

    render();
  </script>
</body>
</html>`;
  }
}

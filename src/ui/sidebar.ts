import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readSettings } from '../config/settings';
import { Credentials } from '../config/credentials';
import { CompletionError } from '../core';
import { ProviderRegistry } from '../providers/registry';
import { Session } from '../services/session';
import { panelCommands, validatePanelSettings } from './messages';
import type { ProjectIndex } from '../project/indexService';

/** 中文控制台：静态资源、本地 CSP、白名单消息，不将 API Key 暴露给 Webview。 */
export class Sidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private revision = 0;
  private saving = false;
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: ProviderRegistry,
    private readonly credentials: Credentials,
    private readonly session: Session,
    private readonly project?: ProjectIndex,
  ) {
    this.subscriptions.push(session.onChange(() => this.refresh()));
    if (project) this.subscriptions.push(project.onEdits(() => this.refresh()));
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(18).toString('base64');
    const uri = (file: string) =>
      view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
    const html = readFileSync(vscode.Uri.joinPath(media, 'sidebar.html').fsPath, 'utf8');
    view.webview.html = html
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{cspSource}}', view.webview.cspSource)
      .replaceAll('{{styleUri}}', uri('sidebar.css'))
      .replaceAll('{{logoUri}}', uri('logo.png'))
      .replaceAll('{{scriptUri}}', uri('sidebar.js'));
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message) => {
        void this.receive(message);
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    );
    this.refresh();
  }

  refresh(configChanged = false): void {
    if (configChanged) this.revision++;
    clearTimeout(this.timer);
    // 状态可能随每个键入变化，合并更新，避免侧边栏频繁重排。
    this.timer = setTimeout(() => {
      void this.sendState();
    }, 80);
  }
  private async sendState(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const generation = ++this.generation;
    const settings = readSettings(vscode.window.activeTextEditor?.document.uri);
    const hasKey = Boolean(await this.credentials.get(settings));
    let requiresKey = true;
    try {
      requiresKey = this.registry.resolve(settings).requiresApiKey !== false;
    } catch {
      /* 未注册服务在控制台显示配置状态。 */
    }
    if (this.view !== view || generation !== this.generation) return;
    void view.webview.postMessage({
      type: 'state',
      revision: this.revision,
      settings,
      hasKey,
      requiresKey,
      providers: this.registry.list(),
      phase: this.session.phase,
      detail: this.session.detail,
      paused: this.session.isPaused(),
      stats: this.session.stats,
      usage: this.session.usage,
      balance: this.session.balance,
      lastSource: this.session.lastSource,
      index: this.project?.stats,
    });
  }
  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const data = message as { type?: unknown; command?: unknown; settings?: unknown };
    try {
      if (data.type === 'ready') await this.sendState();
      else if (
        data.type === 'command' &&
        typeof data.command === 'string' &&
        panelCommands.has(data.command)
      ) {
        await vscode.commands.executeCommand(`autoCompose.${data.command}`);
        this.refresh(true);
      } else if (data.type === 'save') {
        if (this.saving) return;
        const entries = validatePanelSettings(
          data.settings,
          this.registry.list().map((provider) => provider.id),
        );
        this.saving = true;
        try {
          const config = vscode.workspace.getConfiguration(
            'autoCompose',
            vscode.window.activeTextEditor?.document.uri,
          );
          // 先整体校验再依次写入；任意一步失败都明确返回错误，不伪装成保存成功。
          for (const [key, value] of Object.entries(entries)) {
            const inspect = config.inspect(key);
            const applicationScoped = ['provider', 'baseUrl', 'model', 'protocol'].includes(key);
            const target =
              !applicationScoped && inspect?.workspaceFolderValue !== undefined
                ? vscode.ConfigurationTarget.WorkspaceFolder
                : !applicationScoped && inspect?.workspaceValue !== undefined
                  ? vscode.ConfigurationTarget.Workspace
                  : vscode.ConfigurationTarget.Global;
            await config.update(key, value, target);
          }
          void this.view?.webview.postMessage({ type: 'saved' });
          this.refresh(true);
        } finally {
          this.saving = false;
        }
      }
    } catch (error) {
      void this.view?.webview.postMessage({
        type: 'error',
        message:
          error instanceof CompletionError
            ? error.message
            : '操作失败，请检查 VS Code 设置或服务状态。',
      });
    }
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.generation++;
    this.view = undefined;
    this.subscriptions.forEach((item) => item.dispose());
  }
}

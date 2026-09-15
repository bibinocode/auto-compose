import * as vscode from 'vscode';
import { readSettings } from '../config/settings';
import { Session, type Phase } from '../services/session';

const icons: Record<Phase, string> = {
  ready: 'sparkle',
  debouncing: 'clock',
  context: 'search',
  loading: 'sync~spin',
  paused: 'debug-pause',
  disabled: 'circle-slash',
  key: 'key',
  error: 'warning',
  cooldown: 'watch',
};

/** 状态栏不再只打开设置页，点击可切换模型、暂停、测试连接或查看诊断。 */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  private readonly subscription: { dispose(): void };
  constructor(private readonly session: Session) {
    this.item.name = 'Auto Compose';
    this.item.command = 'autoCompose.quickActions';
    this.subscription = session.onChange(() => this.render());
    this.render();
  }
  private render(): void {
    const settings = readSettings(vscode.window.activeTextEditor?.document.uri);
    this.item.text = `$(${icons[this.session.phase]}) Auto Compose`;
    this.item.tooltip = `${this.session.detail}\n${settings.provider} · ${settings.model}\n本次会话已接受 ${this.session.stats.accepted} 次 · 点击打开快捷操作`;
    this.item.show();
  }
  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}

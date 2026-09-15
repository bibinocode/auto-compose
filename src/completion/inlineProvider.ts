import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { readSettings } from '../config/settings';
import { Credentials } from '../config/credentials';
import { ContextService } from '../context/contextService';
import { FilePolicy } from '../context/filePolicy';
import { abortable, CompletionError } from '../core';
import { ProviderRegistry } from '../providers/registry';
import { Session } from '../services/session';
import { CompletionEngine } from './engine';
import { mergeLineTail } from './postprocess';
import { GhostTextAcceptanceTracker } from './GhostTextAcceptanceTracker';

/** 只负责 VS Code 编辑器适配；网络、密钥标识和候选后处理不放在此层。 */
export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private active?: AbortController;
  private lastErrorAt = 0;
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly credentials: Credentials,
    private readonly context: ContextService,
    private readonly policy: FilePolicy,
    private readonly engine: CompletionEngine,
    private readonly session: Session,
    private readonly output: vscode.OutputChannel,
    private readonly acceptance: GhostTextAcceptanceTracker,
  ) {}

  cancel(): void {
    const pending = this.active;
    pending?.abort();
    this.active = undefined;
    if (pending && ['loading', 'context', 'debouncing'].includes(this.session.phase)) this.idle();
  }
  idle(): void {
    if (this.session.isPaused())
      this.session.set(
        'paused',
        `暂停至 ${new Date(this.session.pausedUntil).toLocaleTimeString()}`,
      );
    else if (!readSettings(vscode.window.activeTextEditor?.document.uri).enabled)
      this.session.set('disabled', '自动补全已关闭');
    else this.session.set('ready', '等待输入代码');
  }
  dispose(): void {
    this.cancel();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const started = Date.now();
    this.cancel();
    const settings = readSettings(document.uri);
    const editor = vscode.window.activeTextEditor;
    if (!vscode.workspace.isTrusted || !settings.enabled || this.session.isPaused()) {
      this.idle();
      return [];
    }
    if (
      token.isCancellationRequested ||
      !editor ||
      editor.document !== document ||
      !editor.selection.isEmpty ||
      editor.selections.length !== 1 ||
      settings.disabledLanguages.includes(document.languageId) ||
      !this.policy.isSmall(document, settings)
    )
      return [];

    // 原生 IntelliSense 打开时，仅为已输入至少两个字符且一致的候选追加续写。
    // 插入范围必须覆盖该候选范围，最终文本也必须以选中候选开头，否则 VS Code 不展示灰字。
    const selected = context.selectedCompletionInfo;
    if (
      selected &&
      (selected.range.start.line !== position.line ||
        selected.range.end.line !== position.line ||
        selected.range.end.character !== position.character ||
        document.getText(selected.range).length < 2 ||
        !selected.text.startsWith(document.getText(selected.range)))
    )
      return [];

    const version = document.version;
    const controller = new AbortController();
    this.active = controller;
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      if (
        !(await abortable(this.policy.allows(document.uri, settings), controller.signal)) ||
        controller.signal.aborted
      )
        return [];
      const provider = this.registry.resolve(settings);
      const apiKey = await this.credentials.get(settings);
      if (controller.signal.aborted) return [];
      if (provider.requiresApiKey !== false && !apiKey) {
        this.session.set('key', '请设置当前服务的 API Key');
        return [];
      }
      this.session.set('context', '整理光标附近上下文');
      const contextStarted = Date.now();
      const request = await this.context.collect(document, position, settings, controller.signal);
      if (controller.signal.aborted || !request.prefix.trim()) return [];
      const contextMs = Date.now() - contextStarted;
      let selectedRemainder = '';
      if (selected) {
        selectedRemainder = selected.text.slice(document.getText(selected.range).length);
        request.prefix = (request.prefix + selectedRemainder).slice(-settings.prefixChars);
      }
      const result = await this.engine.generate({
        request,
        settings,
        provider,
        apiKey,
        documentId: document.uri.toString(),
        offset: document.offsetAt(position) + selectedRemainder.length,
        eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
        signal: controller.signal,
        notBefore:
          context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
            ? 0
            : started + settings.debounceMs,
      });
      if (
        controller.signal.aborted ||
        token.isCancellationRequested ||
        document.version !== version ||
        vscode.window.activeTextEditor?.document !== document ||
        !editor.selection.active.isEqual(position)
      )
        return [];
      this.session.stats.lastContextMs = contextMs;
      this.session.stats.lastReadyMs = Date.now() - started;
      this.session.lastSource = result.source;
      if (!result.text) {
        this.session.set(
          'ready',
          result.rejection ? `已拦截：${result.rejection}` : '本次没有合适候选',
        );
        return [];
      }
      const end = document.lineAt(position.line).range.end;
      const tail = document.getText(new vscode.Range(position, end));
      const insert = mergeLineTail((selected ? selected.text : '') + result.text, tail);
      const id = randomUUID();
      const item = new vscode.InlineCompletionItem(
        insert,
        new vscode.Range(selected?.range.start ?? position, end),
      );
      item.command = { command: 'autoCompose.accepted', title: '记录补全接受', arguments: [id] };
      const start = selected?.range.start ?? position;
      this.acceptance.expect({
        id,
        uri: document.uri.toString(),
        version: document.version,
        offset: document.offsetAt(start),
        replacedText: document.getText(new vscode.Range(start, end)),
        insertText: insert,
      });
      this.session.offer(id, result.text.length);
      this.session.set(
        'ready',
        result.source === 'network' ? '候选已就绪 · Tab 接受' : '候选已复用 · Tab 接受',
      );
      return [item];
    } catch (error) {
      if (controller.signal.aborted) {
        this.session.stats.cancelled++;
        return [];
      }
      const message =
        error instanceof CompletionError
          ? error.message
          : '补全 Provider 执行失败，请检查实现与配置。';
      this.session.stats.errors++;
      this.session.set(
        error instanceof CompletionError && error.status === 429 ? 'cooldown' : 'error',
        message,
      );
      if (Date.now() - this.lastErrorAt > 10000) {
        this.output.appendLine(message);
        this.lastErrorAt = Date.now();
      }
      return [];
    } finally {
      subscription.dispose();
      if (this.active === controller) {
        this.active = undefined;
        if (['loading', 'context', 'debouncing'].includes(this.session.phase)) this.idle();
      }
    }
  }
}

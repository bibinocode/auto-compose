import * as vscode from 'vscode';
import { readSettings, type Settings } from './config/settings';
import { Credentials } from './config/credentials';
import { ProviderRegistry } from './providers/registry';
import { Session } from './services/session';
import { abortable, CompletionError } from './core';

export interface CommandServices {
  credentials: Credentials;
  registry: ProviderRegistry;
  session: Session;
  output: vscode.OutputChannel;
  invalidate(): void;
  cancel(): void;
  refresh(): void;
}

/** 命令层统一处理原生交互；密码不经过侧边栏 DOM。 */
export function registerCommands(
  context: vscode.ExtensionContext,
  services: CommandServices,
): void {
  const { credentials, registry, session, output } = services;
  const tests = new Set<AbortController>();
  let balanceRequest: AbortController | undefined;
  const register = (name: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`autoCompose.${name}`, handler));
  const setKey = async (settings: Settings = readSettings()): Promise<boolean> => {
    const key = await vscode.window.showInputBox({
      title: `Auto Compose · ${settings.provider} API Key`,
      prompt: `密钥安全存储于当前服务：${['deepseek', 'openai-compatible'].includes(settings.provider) ? settings.baseUrl : settings.provider}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '请输入 API Key'),
    });
    if (!key?.trim()) return false;
    await credentials.set(settings, key);
    services.invalidate();
    services.refresh();
    void vscode.window.showInformationMessage('API Key 已安全保存，可以开始输入代码。');
    return true;
  };
  register('setApiKey', () => setKey());
  register('deleteApiKey', async () => {
    await credentials.delete(readSettings());
    services.invalidate();
    services.refresh();
    void vscode.window.showInformationMessage('当前服务密钥已删除。');
  });
  register('openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
  );
  register('openPanel', () => vscode.commands.executeCommand('autoCompose.sidebar.focus'));
  register('showOutput', () => output.show(true));
  register('trigger', () => vscode.commands.executeCommand('editor.action.inlineSuggest.trigger'));
  register('accepted', (id) => {
    if (typeof id === 'string') session.accept(id);
  });
  register('clearCache', () => {
    services.invalidate();
    void vscode.window.showInformationMessage('补全缓存已清空。');
  });
  register('pause', () => {
    services.cancel();
    session.pause(10);
  });
  register('resume', () => {
    session.resume();
    services.refresh();
  });
  register('toggle', async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const config = vscode.workspace.getConfiguration('autoCompose', uri);
    const inspect = config.inspect<boolean>('enabled');
    // 修改当前真正生效的层级，避免全局开关被已有工作区配置覆盖。
    const target =
      inspect?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspect?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await config.update('enabled', !config.get('enabled', true), target);
    services.invalidate();
    services.refresh();
  });
  register('selectProvider', async () => {
    const choice = await vscode.window.showQuickPick(
      registry.list().map((provider) => ({
        label: provider.displayName,
        description: provider.id,
        id: provider.id,
      })),
      { title: '选择补全服务' },
    );
    if (!choice) return;
    const config = vscode.workspace.getConfiguration('autoCompose');
    await config.update('provider', choice.id, vscode.ConfigurationTarget.Global);
    if (choice.id === 'deepseek') {
      await config.update('baseUrl', '', vscode.ConfigurationTarget.Global);
      await config.update('model', '', vscode.ConfigurationTarget.Global);
    }
    if (choice.id === 'openai-compatible')
      await vscode.commands.executeCommand('autoCompose.openPanel');
  });
  register('selectModel', async () => {
    const model = await vscode.window.showInputBox({
      title: '设置补全模型',
      value: readSettings().model,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : '请输入模型名称'),
    });
    if (model?.trim())
      await vscode.workspace
        .getConfiguration('autoCompose')
        .update('model', model.trim(), vscode.ConfigurationTarget.Global);
  });
  register('quickActions', async () => {
    const actions = [
      { label: '$(dashboard) 打开补全控制台', command: 'openPanel' },
      { label: '$(key) 设置 API Key', command: 'setApiKey' },
      { label: '$(server) 切换 Provider', command: 'selectProvider' },
      { label: '$(symbol-method) 切换模型', command: 'selectModel' },
      {
        label: session.isPaused() ? '$(play) 恢复补全' : '$(debug-pause) 暂停 10 分钟',
        command: session.isPaused() ? 'resume' : 'pause',
      },
      { label: '$(circle-slash) 开启 / 关闭', command: 'toggle' },
      { label: '$(plug) 测试连接', command: 'testConnection' },
      { label: '$(pulse) 运行环境诊断', command: 'diagnostics' },
    ];
    const selected = await vscode.window.showQuickPick(actions, {
      title: 'Auto Compose',
      placeHolder: session.detail,
    });
    if (selected) await vscode.commands.executeCommand(`autoCompose.${selected.command}`);
  });
  register('diagnostics', async () => {
    const settings = readSettings(vscode.window.activeTextEditor?.document.uri);
    let providerState = '已就绪';
    try {
      registry.resolve(settings);
    } catch {
      providerState = '未注册';
    }
    const lines = [
      `Auto Compose 运行诊断 · ${new Date().toLocaleString()}`,
      `VS Code: ${vscode.version} · 工作区信任: ${vscode.workspace.isTrusted}`,
      `Provider: ${providerState} · Key: ${(await credentials.get(settings)) ? '已保存' : '未保存'}`,
      `扩展开关: ${settings.enabled} · 会话暂停: ${session.isPaused()}`,
      `编辑器灰字开关: ${vscode.workspace.getConfiguration('editor').get('inlineSuggest.enabled', true)}`,
      `流式: ${settings.streaming} · 多行: ${settings.multiline} · 上下文: ${settings.contextMode} · 定义: ${settings.useDefinitions}`,
      `当前状态: ${session.detail}`,
      `会话统计: ${JSON.stringify(session.stats)}`,
      '如果没有灰字：检查当前文件排除规则、多光标、密钥、模型权限及其他 AI 补全扩展。',
    ];
    output.appendLine(lines.join('\n'));
    output.show(true);
  });
  register('refreshBalance', async () => {
    balanceRequest?.abort();
    const settings = readSettings();
    const controller = new AbortController();
    balanceRequest = controller;
    tests.add(controller);
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
    session.balance = '查询中…';
    session.changed();
    try {
      const provider = registry.resolve(settings);
      if (!provider.getBalance) throw new CompletionError('当前 Provider 未提供余额查询。');
      const apiKey = await credentials.get(settings);
      if (!apiKey && provider.requiresApiKey !== false)
        throw new CompletionError('请先设置 API Key。');
      const balances = await abortable(
        provider.getBalance({ apiKey, signal: controller.signal }),
        controller.signal,
      );
      if (!controller.signal.aborted && balanceRequest === controller)
        session.balance =
          balances.map((item) => `${item.currency} ${item.total}`).join(' / ') +
          `（${new Date().toLocaleTimeString()}）`;
    } catch (error) {
      if (balanceRequest === controller)
        session.balance = controller.signal.aborted
          ? '查询已取消或超时，请刷新'
          : error instanceof CompletionError
            ? error.message
            : '余额查询失败，请重试';
    } finally {
      clearTimeout(timeout);
      tests.delete(controller);
      controller.abort();
      session.changed();
    }
  });
  register('testConnection', async () => {
    const settings = readSettings();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = registry.resolve(settings);
      let apiKey = await credentials.get(settings);
      if (provider.requiresApiKey !== false && !apiKey) {
        if (!(await setKey(settings))) return;
        apiKey = await credentials.get(settings);
      }
      tests.add(controller);
      timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Auto Compose：测试连接',
          cancellable: true,
        },
        async (_, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          if (token.isCancellationRequested) controller.abort();
          const accounting = session.beginUsage();
          try {
            const start = Date.now();
            const text = await abortable(
              provider.complete(
                {
                  prefix: 'function add(a, b) {\n  return',
                  suffix: '\n}',
                  languageId: 'javascript',
                  maxTokens: 32,
                },
                { apiKey, signal: controller.signal, onUsage: accounting.report },
              ),
              controller.signal,
            );
            if (typeof text !== 'string')
              throw new CompletionError('Provider 返回值必须是字符串。');
            void vscode.window.showInformationMessage(
              `连接成功 · ${Date.now() - start}ms · 已收到补全响应`,
            );
          } finally {
            accounting.finish();
            subscription.dispose();
          }
        },
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        controller.signal.aborted
          ? '连接测试已取消或超时。'
          : error instanceof CompletionError
            ? error.message
            : '连接测试失败，请检查 Provider。',
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
      tests.delete(controller);
      services.refresh();
    }
  });
  const cancelTests = () => {
    // 切换服务或密钥后旧余额请求不得覆盖新账户状态。
    balanceRequest = undefined;
    for (const controller of tests) controller.abort();
  };
  context.subscriptions.push(
    { dispose: cancelTests },
    context.secrets.onDidChange(cancelTests),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('autoCompose')) cancelTests();
    }),
  );
}

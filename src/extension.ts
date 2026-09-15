import * as vscode from 'vscode';
import type { AutoComposeApi } from './api';
import { registerCommands } from './commands';
import { Credentials } from './config/credentials';
import { ContextService } from './context/contextService';
import { FilePolicy } from './context/filePolicy';
import { CompletionEngine } from './completion/engine';
import { InlineProvider } from './completion/inlineProvider';
import { ProviderRegistry } from './providers/registry';
import { Session } from './services/session';
import { Sidebar } from './ui/sidebar';
import { StatusBar } from './ui/status';
import { ProjectIndex } from './project/indexService';
import { ProjectSymbolCompletion } from './project/symbolCompletion';
import { LinkedEdits } from './edits/linkedEdits';
import { GhostTextAcceptanceTracker } from './completion/GhostTextAcceptanceTracker';

/** 扩展入口只组装服务与事件；所有资源都随 ExtensionContext 一起释放。 */
export function activate(context: vscode.ExtensionContext): AutoComposeApi {
  const output = vscode.window.createOutputChannel('Auto Compose');
  const session = new Session(context.globalState.get('tokenUsage'), (usage) => {
    void context.globalState.update('tokenUsage', usage);
  });
  const credentials = new Credentials(context.secrets);
  const policy = new FilePolicy();
  const project = new ProjectIndex(context.extensionUri, policy);
  const linked = new LinkedEdits(project, policy);
  const acceptance = new GhostTextAcceptanceTracker();
  const contexts = new ContextService(policy, project);
  const engine = new CompletionEngine(session);
  let inline: InlineProvider;
  let sidebar: Sidebar;
  const invalidate = () => {
    session.balance = '尚未查询';
    inline?.cancel();
    acceptance.clear();
    engine.clear();
    policy.clear();
    inline?.idle();
    sidebar?.refresh(true);
  };
  const registry = new ProviderRegistry(invalidate);
  inline = new InlineProvider(
    registry,
    credentials,
    contexts,
    policy,
    engine,
    session,
    output,
    acceptance,
  );
  sidebar = new Sidebar(context.extensionUri, registry, credentials, session, project);
  const status = new StatusBar(session);
  registerCommands(context, {
    credentials,
    registry,
    session,
    output,
    invalidate,
    cancel: () => inline.cancel(),
    refresh: () => {
      inline.idle();
      sidebar.refresh(true);
    },
  });

  context.subscriptions.push(
    output,
    session,
    registry,
    inline,
    sidebar,
    status,
    project,
    linked,
    vscode.workspace.registerTextDocumentContentProvider('auto-compose-preview', linked),
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'typescript' },
        { language: 'javascript' },
        { language: 'typescriptreact' },
        { language: 'javascriptreact' },
      ],
      linked,
    ),
    vscode.languages.registerCompletionItemProvider(
      [
        { language: 'typescript' },
        { language: 'javascript' },
        { language: 'typescriptreact' },
        { language: 'javascriptreact' },
      ],
      new ProjectSymbolCompletion(project, policy),
    ),
    vscode.commands.registerCommand('autoCompose.previewLinkedEdit', (id?: string) =>
      linked.preview(id),
    ),
    vscode.commands.registerCommand('autoCompose.applyLinkedEdit', (id?: string) =>
      linked.apply(id),
    ),
    vscode.commands.registerCommand('autoCompose.rebuildIndex', () => project.invalidate()),
    vscode.commands.registerCommand('autoCompose.indexStatus', () =>
      vscode.window.showInformationMessage(
        `项目索引：${project.stats.files} 个文件，${project.stats.symbols} 个导出符号，${project.stats.ready ? '可查询' : '构建中或已关闭'}。`,
      ),
    ),
    vscode.window.registerWebviewViewProvider('autoCompose.sidebar', sidebar),
    vscode.languages.registerInlineCompletionItemProvider(
      [
        { scheme: 'file' },
        { scheme: 'untitled' },
        { scheme: 'vscode-remote' },
        { scheme: 'vscode-notebook-cell' },
      ],
      inline,
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('autoCompose')) invalidate();
      if (
        [
          'autoCompose.projectIndex',
          'autoCompose.indexMaxFiles',
          'autoCompose.excludePatterns',
          'autoCompose.maxFileChars',
        ].some((key) => event.affectsConfiguration(key))
      )
        project.invalidate();
    }),
    context.secrets.onDidChange(invalidate),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const accepted = acceptance.onDocumentChange(
        event.document.uri.toString(),
        event.document.version,
        event.contentChanges,
        (start, end) =>
          event.document.getText(
            new vscode.Range(event.document.positionAt(start), event.document.positionAt(end)),
          ),
      );
      if (accepted?.kind === 'full') session.accept(accepted.id);
      if (!accepted && event.document === vscode.window.activeTextEditor?.document) inline.cancel();
      // 接受的灰字也是用户认可的编辑证据；只有应用联动补丁本身不再学习，避免回声循环。
      project.observe(event.document, !linked.applying, Boolean(accepted) || linked.applying);
      if (event.contentChanges.length)
        contexts.record(event.document, event.contentChanges[0].range.start.line);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.path.endsWith('/.autocomposeignore')) {
        invalidate();
        project.invalidate();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      inline.cancel();
      acceptance.clear();
      inline.idle();
      sidebar.refresh(true);
      if (editor) contexts.record(editor.document, editor.selection.active.line);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // 接受追踪优先于普通光标取消处理，保留接受引发的后续联动链。
      const document = event.textEditor.document;
      const accepted = acceptance.onSelectionChange(
        document.uri.toString(),
        document.version,
        document.offsetAt(event.textEditor.selection.active),
      );
      if (!accepted && event.textEditor === vscode.window.activeTextEditor) inline.cancel();
      contexts.record(event.textEditor.document, event.textEditor.selection.active.line);
    }),
    {
      dispose() {
        engine.clear();
        policy.clear();
        contexts.clear();
      },
    },
  );
  const sourceWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}',
  );
  context.subscriptions.push(
    sourceWatcher,
    sourceWatcher.onDidCreate((uri) => {
      void project.refreshFile(uri);
    }),
    sourceWatcher.onDidChange((uri) => {
      void project.refreshFile(uri);
    }),
    sourceWatcher.onDidDelete((uri) => {
      void project.remove(uri);
    }),
  );
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    '**/{tsconfig.json,.autocomposeignore}',
  );
  context.subscriptions.push(
    configWatcher,
    configWatcher.onDidChange(() => project.invalidate()),
    configWatcher.onDidCreate(() => project.invalidate()),
    configWatcher.onDidDelete(() => project.invalidate()),
  );
  void project.start();
  // 外部编辑器修改 ignore 文件也应即时生效，不能只监听 VS Code 内部保存。
  const watcher = vscode.workspace.createFileSystemWatcher('**/.autocomposeignore');
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(invalidate),
    watcher.onDidCreate(invalidate),
    watcher.onDidDelete(invalidate),
  );
  const editor = vscode.window.activeTextEditor;
  if (editor) contexts.record(editor.document, editor.selection.active.line);
  inline.idle();
  if (!context.globalState.get('welcomed')) {
    void context.globalState.update('welcomed', true);
    void vscode.window
      .showInformationMessage(
        'Auto Compose：设置 API Key 即可开始代码补全。',
        '设置 API Key',
        '打开控制台',
      )
      .then((choice) => {
        if (choice)
          void vscode.commands.executeCommand(
            choice === '设置 API Key' ? 'autoCompose.setApiKey' : 'autoCompose.openPanel',
          );
      });
  }
  return {
    version: 1,
    registerProvider: (provider) => registry.register(provider),
    getProjectStatus: () => ({ ...project.stats }),
  };
}

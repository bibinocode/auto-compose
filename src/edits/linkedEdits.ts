import * as vscode from 'vscode';
import { ProjectIndex } from '../project/indexService';
import type { LinkedEdit } from '../project/types';
import { FilePolicy } from '../context/filePolicy';
import { readSettings } from '../config/settings';
import { withinRoot } from '../project/paths';

/**
 * 只展示有结构/引用证据的小范围联动，不在用户键入时静默改动调用处。
 * 应用前重新检查整份文件快照和目标文本，防止过期偏移覆盖用户的新修改。
 */
export class LinkedEdits
  implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider, vscode.Disposable
{
  private edits: LinkedEdit[] = [];
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changes.event;
  private readonly previews = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  applying = false;
  constructor(
    private readonly index: ProjectIndex,
    private readonly policy: FilePolicy,
  ) {
    this.subscriptions.push(
      index.onEdits((edits) => {
        this.edits = edits;
        this.changes.fire();
      }),
    );
  }
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!readSettings(document.uri).linkedEdits) return [];
    return this.edits
      .filter((edit) => edit.file === document.uri.path)
      .map(
        (edit) =>
          new vscode.CodeLens(
            new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
            {
              title: `Auto Compose：${edit.kind === 'signature' ? '更新调用参数' : '应用相同修改'} · 预览`,
              command: 'autoCompose.previewLinkedEdit',
              arguments: [edit.id],
            },
          ),
      );
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.previews.get(uri.toString()) ?? '';
  }
  private uri(file: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.find((folder) =>
      withinRoot(file, folder.uri.path),
    );
    return folder?.uri.with({ path: file });
  }
  private async choose(id?: string): Promise<LinkedEdit | undefined> {
    if (id) return this.edits.find((edit) => edit.id === id);
    const choices = this.edits.map((edit) => ({
      label: `${edit.kind === 'signature' ? '调用参数' : '相同修改'}：${edit.before} → ${edit.after}`,
      description: vscode.workspace.asRelativePath(edit.file),
      detail: edit.reason,
      edit,
    }));
    if (!choices.length) {
      void vscode.window.showInformationMessage('当前没有证据充分的局部联动建议。');
      return;
    }
    return (
      await vscode.window.showQuickPick(choices, {
        title: '局部联动建议',
        matchOnDescription: true,
      })
    )?.edit;
  }
  async preview(id?: string): Promise<void> {
    const edit = await this.choose(id);
    if (!edit) return;
    const uri = this.uri(edit.file);
    if (!uri) return;
    const document = await vscode.workspace.openTextDocument(uri);
    const source = vscode.workspace.textDocuments.find(
      (document) => document.uri.path === edit.sourceFile,
    );
    if (source && source.getText() !== this.index.snapshot(edit.sourceFile)?.text) {
      this.dismiss(edit.id);
      return;
    }
    const original = document.getText();
    if (
      original !== this.index.snapshot(edit.file)?.text ||
      original.slice(edit.start, edit.end) !== edit.before
    ) {
      this.dismiss(edit.id);
      return;
    }
    const previewUri = vscode.Uri.parse(
      `auto-compose-preview:/change-${Date.now()}-${encodeURIComponent(edit.id)}.ts`,
    );
    this.previews.set(
      previewUri.toString(),
      original.slice(0, edit.start) + edit.after + original.slice(edit.end),
    );
    if (this.previews.size > 10) this.previews.delete(this.previews.keys().next().value!);
    await vscode.commands.executeCommand(
      'vscode.diff',
      uri,
      previewUri,
      `Auto Compose · ${edit.reason}`,
      { preview: true },
    );
    // 用户已看到实际差异，通知提供单次接受入口，Esc/忽略不会改文件。
    const choice = await vscode.window.showInformationMessage(edit.reason, '应用此修改', '忽略');
    if (choice === '应用此修改') await this.apply(edit.id);
    else if (choice === '忽略') this.dismiss(edit.id);
  }
  async apply(id?: string): Promise<boolean> {
    const edit = await this.choose(id);
    if (!edit) return false;
    const uri = this.uri(edit.file);
    if (!uri || !(await this.policy.allows(uri, readSettings(uri)))) return false;
    const document = await vscode.workspace.openTextDocument(uri);
    const source = vscode.workspace.textDocuments.find(
      (document) => document.uri.path === edit.sourceFile,
    );
    if (source && source.getText() !== this.index.snapshot(edit.sourceFile)?.text) {
      this.dismiss(edit.id);
      return false;
    }
    if (
      document.getText() !== this.index.snapshot(edit.file)?.text ||
      document.getText(
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
      ) !== edit.before
    ) {
      this.dismiss(edit.id);
      void vscode.window.showInformationMessage('代码已变化，该建议已过期，请等待索引更新。');
      return false;
    }
    const transaction = new vscode.WorkspaceEdit();
    transaction.replace(
      uri,
      new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
      edit.after,
    );
    this.applying = true;
    try {
      const applied = await vscode.workspace.applyEdit(transaction);
      if (applied) {
        this.dismiss(edit.id);
        this.index.observe(document, false, true);
        await this.index.flush();
      }
      return applied;
    } finally {
      this.applying = false;
    }
  }
  dismiss(id: string): void {
    this.edits = this.edits.filter((edit) => edit.id !== id);
    this.changes.fire();
  }
  dispose(): void {
    this.subscriptions.forEach((item) => item.dispose());
    this.changes.dispose();
    this.previews.clear();
  }
}

import * as vscode from 'vscode';
import { ProjectIndex } from './indexService';
import { readSettings } from '../config/settings';
import { FilePolicy } from '../context/filePolicy';

/** 未打开文件的函数名走本地索引，直接提供 IntelliSense 和 import，不等待远端生成。 */
export class ProjectSymbolCompletion implements vscode.CompletionItemProvider {
  constructor(
    private readonly index: ProjectIndex,
    private readonly policy: FilePolicy,
  ) {}
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    if (!readSettings(document.uri).projectIndex || !readSettings(document.uri).enabled) return [];
    const settings = readSettings(document.uri);
    if (
      !this.policy.isSmall(document, settings) ||
      !(await this.policy.allows(document.uri, settings)) ||
      token.isCancellationRequested
    )
      return [];
    const range = document.getWordRangeAtPosition(position);
    const word = range ? document.getText(new vscode.Range(range.start, position)) : '';
    if (word.length < 2) return [];
    const preceding = document.getText(
      new vscode.Range(new vscode.Position(position.line, 0), range?.start ?? position),
    );
    if (/[.\w$]$/.test(preceding) || /^\s*import\b/.test(preceding)) return [];
    const version = document.version;
    const matches = await this.index.query(document.uri, word, document.getText());
    if (token.isCancellationRequested || document.version !== version) return [];
    return matches
      .filter(
        (match) => match.name.toLowerCase().startsWith(word.toLowerCase()) && match.importText,
      )
      .map((match) => {
        const item = new vscode.CompletionItem(
          match.name,
          match.kind === 'function'
            ? vscode.CompletionItemKind.Function
            : match.kind === 'class'
              ? vscode.CompletionItemKind.Class
              : vscode.CompletionItemKind.Interface,
        );
        item.detail = `${match.signature} · 项目符号`;
        item.documentation = new vscode.MarkdownString().appendText(
          `${match.documentation}\n来源：${vscode.workspace.asRelativePath(match.file)}`,
        );
        item.range = range;
        item.insertText = match.name;
        item.sortText = `0_${match.name}`;
        item.additionalTextEdits = [
          vscode.TextEdit.insert(document.positionAt(match.importOffset ?? 0), match.importText!),
        ];
        // 首行从第 0 列开始补全时，导入插入点与主编辑重合，合并成一次编辑。
        if (range && document.offsetAt(range.start) === (match.importOffset ?? 0)) {
          item.insertText = match.importText + match.name;
          item.additionalTextEdits = [];
        }
        return item;
      });
  }
}

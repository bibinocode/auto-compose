import * as vscode from 'vscode';
import picomatch from 'picomatch';
import ignore, { type Ignore } from 'ignore';
import type { Settings } from '../config/settings';

/** 统一用于主文件、关联片段和 LSP 定义，避免上下文检索绕过文件排除。 */
export class FilePolicy {
  private readonly ignoreFiles = new Map<string, Promise<Ignore>>();
  clear(): void {
    this.ignoreFiles.clear();
  }

  async allows(uri: vscode.Uri, settings: Settings): Promise<boolean> {
    if (!['file', 'untitled', 'vscode-remote', 'vscode-notebook-cell'].includes(uri.scheme))
      return false;
    if (
      settings.excludePatterns.length &&
      picomatch(settings.excludePatterns, { dot: true, nocase: true })(uri.path.replace(/\\/g, '/'))
    )
      return false;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return true;
    const root = folder.uri.toString();
    let rules = this.ignoreFiles.get(root);
    if (!rules) {
      rules = Promise.resolve(
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.autocomposeignore')),
      ).then(
        (content) => ignore().add(new TextDecoder().decode(content)),
        () => ignore(),
      );
      this.ignoreFiles.set(root, rules);
    }
    const relative = uri.path.slice(folder.uri.path.replace(/\/$/, '').length + 1);
    return !relative || !(await rules).ignores(relative);
  }

  /** 从行索引计算长度，不为超大文件创建完整字符串副本。 */
  isSmall(document: vscode.TextDocument, settings: Settings): boolean {
    return (
      document.offsetAt(document.lineAt(document.lineCount - 1).range.end) <= settings.maxFileChars
    );
  }
}

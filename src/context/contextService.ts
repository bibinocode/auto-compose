import * as vscode from 'vscode';
import type { CompletionRequest, ContextSnippet } from '../api';
import type { Settings } from '../config/settings';
import { abortable } from '../core';
import { FilePolicy } from './filePolicy';
import { chooseWindow, identifiers } from './ranking';
import type { ProjectIndex } from '../project/indexService';
import { lineLimit } from '../completion/postprocess';

/**
 * 上下文服务只维护最近访问位置，不持久化源码。
 * 默认只读当前文件；关联文件和语言服务定义分别由用户设置开启。
 */
export class ContextService {
  private readonly recent = new Map<string, { line: number; time: number }>();
  constructor(
    private readonly policy: FilePolicy,
    private readonly project?: ProjectIndex,
  ) {}
  record(document: vscode.TextDocument, line: number): void {
    const key = document.uri.toString();
    this.recent.delete(key);
    this.recent.set(key, { line, time: Date.now() });
    if (this.recent.size > 20) this.recent.delete(this.recent.keys().next().value!);
  }
  clear(): void {
    this.recent.clear();
  }

  async collect(
    document: vscode.TextDocument,
    position: vscode.Position,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<CompletionRequest> {
    const offset = document.offsetAt(position);
    const request: CompletionRequest = {
      prefix: document.getText(
        new vscode.Range(document.positionAt(Math.max(0, offset - settings.prefixChars)), position),
      ),
      suffix: document.getText(
        new vscode.Range(position, document.positionAt(offset + settings.suffixChars)),
      ),
      languageId: document.languageId,
      maxTokens: settings.maxTokens,
    };
    if (settings.projectContext && settings.contextChars && this.project) {
      // 下方预算在返回前统一设置；保留原始注释与代码窗口。
      const matches = await this.project.query(document.uri, request.prefix);
      let remaining = settings.contextChars;
      const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.path ?? '';
      request.context = matches.slice(0, 3).flatMap((match) => {
        const content = `${match.documentation}\n${match.signature}\n${match.importText ?? ''}`
          .trim()
          .slice(0, remaining);
        remaining -= content.length;
        return content
          ? [{ filepath: match.file.slice(root.length + 1), content, source: 'project' as const }]
          : [];
      });
    }
    request.maxLines = lineLimit(request.prefix, settings, request.languageId);
    if (
      !settings.contextChars ||
      (!settings.useDefinitions && settings.contextMode === 'current-file')
    )
      return request;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return request;

    // 关联上下文只有 180ms 预算，语言服务未就绪时不拖慢主要补全链路。
    const bounded = new AbortController();
    const cancel = () => bounded.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 180);
    if (signal.aborted) bounded.abort();
    const snippets: ContextSnippet[] = request.context ?? [];
    try {
      const work = this.related(
        document,
        position,
        request.prefix,
        folder.uri,
        settings,
        bounded.signal,
        snippets,
      );
      await abortable(work, bounded.signal);
    } catch {
      // 上下文检索属于可降级能力；主请求的取消由上层统一处理。
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
    // 定义服务超时时仍保留已经取得的最近文件片段；超时后 add() 不再写入。
    if (!signal.aborted && snippets.length) request.context = snippets;
    return request;
  }

  private async related(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string,
    root: vscode.Uri,
    settings: Settings,
    signal: AbortSignal,
    snippets: ContextSnippet[],
  ): Promise<ContextSnippet[]> {
    const query = identifiers(prefix.slice(-2000));
    let remaining =
      settings.contextChars - snippets.reduce((sum, snippet) => sum + snippet.content.length, 0);
    const sameRoot = (uri: vscode.Uri) =>
      vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === root.toString();
    const add = (uri: vscode.Uri, content: string, source: ContextSnippet['source']) => {
      if (signal.aborted || remaining <= 0 || !content.trim()) return;
      const filepath = uri.path.slice(root.path.replace(/\/$/, '').length + 1);
      if (snippets.some((snippet) => snippet.filepath === filepath)) return;
      const bounded = content.slice(0, remaining);
      snippets.push({ filepath, content: bounded, source });
      remaining -= bounded.length;
    };

    if (settings.contextMode === 'open-files') {
      const candidates: {
        document: vscode.TextDocument;
        content: string;
        score: number;
        time: number;
      }[] = [];
      for (const other of vscode.workspace.textDocuments) {
        if (signal.aborted) return snippets;
        const visited = this.recent.get(other.uri.toString());
        if (
          !visited ||
          other === document ||
          !sameRoot(other.uri) ||
          !this.policy.isSmall(other, settings) ||
          settings.disabledLanguages.includes(other.languageId) ||
          !(await this.policy.allows(other.uri, settings))
        )
          continue;
        const window = chooseWindow(
          other.getText(),
          query,
          visited.line,
          Math.min(1600, remaining),
        );
        candidates.push({ document: other, ...window, time: visited.time });
      }
      candidates.sort((a, b) => b.score - a.score || b.time - a.time);
      // 给定义检索预留空间，优先最多两个最近文件。
      for (const candidate of candidates.slice(0, settings.useDefinitions ? 2 : 3))
        add(candidate.document.uri, candidate.content, 'recent');
    }

    if (settings.useDefinitions && remaining > 0 && !signal.aborted) {
      const word = prefix.match(/[A-Za-z_$][\w$]*(?=[^\w$]*$)/)?.[0];
      if (!word) return snippets;
      const wordOffset = prefix.lastIndexOf(word);
      const location = document.positionAt(
        document.offsetAt(position) - prefix.length + wordOffset,
      );
      const definitions = await vscode.commands.executeCommand<
        (vscode.Location | vscode.LocationLink)[]
      >('vscode.executeDefinitionProvider', document.uri, location);
      for (const definition of (definitions ?? []).slice(0, 2)) {
        if (signal.aborted) break;
        const uri = 'targetUri' in definition ? definition.targetUri : definition.uri;
        const range = 'targetRange' in definition ? definition.targetRange : definition.range;
        if (
          uri.toString() === document.uri.toString() ||
          !sameRoot(uri) ||
          !(await this.policy.allows(uri, settings))
        )
          continue;
        if (signal.aborted) break;
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > settings.maxFileChars * 4 || signal.aborted) continue;
        const target = await vscode.workspace.openTextDocument(uri);
        if (
          signal.aborted ||
          !this.policy.isSmall(target, settings) ||
          settings.disabledLanguages.includes(target.languageId)
        )
          continue;
        const end = target.positionAt(
          Math.min(target.offsetAt(range.end), target.offsetAt(range.start) + remaining),
        );
        add(uri, target.getText(new vscode.Range(range.start, end)), 'definition');
      }
    }
    return snippets;
  }
}

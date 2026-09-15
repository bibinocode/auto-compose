import * as vscode from 'vscode';
import { Worker } from 'node:worker_threads';
import { readSettings } from '../config/settings';
import { FilePolicy } from '../context/filePolicy';
import type { IndexedFile, IndexStats, LinkedEdit, ProjectConfig, SymbolMatch } from './types';
import { withinRoot } from './paths';

const include = '**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';
const exclude = '**/{node_modules,.git,dist,build,coverage,.next,vendor,artifacts}/**';

/**
 * 后台建立有界工作区索引，变更以 350ms 合并；查询只消费 Worker 已完成的快照。
 * 文件内容只保留在内存，索引本身不发网络请求；发送给模型的仅是命中的少量符号。
 */
export class ProjectIndex implements vscode.Disposable {
  stats: IndexStats = { files: 0, symbols: 0, ready: false };
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly snapshots = new Map<string, IndexedFile>();
  private readonly queued = new Map<
    string,
    { document: vscode.TextDocument; learn: boolean; preserve: boolean }
  >();
  private readonly listeners = new Set<(edits: LinkedEdit[]) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private loading = false;
  private restartRequested = false;
  private disposed = false;
  private epoch = 0;
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly policy: FilePolicy,
  ) {}
  onEdits(listener: (edits: LinkedEdit[]) => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
  private publish(edits: LinkedEdit[]): void {
    for (const listener of this.listeners) listener(edits);
  }

  async start(): Promise<void> {
    if (
      this.disposed ||
      this.loading ||
      !vscode.workspace.isTrusted ||
      !vscode.workspace.workspaceFolders?.length ||
      !readSettings().projectIndex
    )
      return;
    this.loading = true;
    const epoch = ++this.epoch;
    try {
      this.worker ??= new Worker(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'projectWorker.js').fsPath,
      );
      if (this.worker.listenerCount('message') === 0) {
        this.worker.on('message', ({ id, result, error }) => {
          const waiter = this.pending.get(id);
          if (!waiter) return;
          clearTimeout(waiter.timer);
          this.pending.delete(id);
          if (error) waiter.reject(new Error(error));
          else waiter.resolve(result);
        });
        this.worker.on('error', () => this.stopWorker());
      }
      const settings = readSettings();
      const uris = await vscode.workspace.findFiles(include, exclude, settings.indexMaxFiles);
      const files: IndexedFile[] = [];
      const configs: ProjectConfig[] = [];
      let bytes = 0;
      for (const folder of vscode.workspace.workspaceFolders) {
        let options: Record<string, unknown> = {};
        try {
          const raw = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'tsconfig.json')),
          );
          // JSONC 的解析交给后台 TypeScript；此处仅保存配置文本，避免阻塞宿主。
          configs.push({ root: folder.uri.path, options: { __raw: raw } });
          continue;
        } catch {
          /* 没有 tsconfig 的 JS 项目使用默认模块解析。 */
        }
        configs.push({ root: folder.uri.path, options });
      }
      for (let start = 0; start < uris.length && bytes < 32 * 1024 * 1024; start += 8) {
        if (this.disposed || epoch !== this.epoch) return;
        const batch = await Promise.all(
          uris.slice(start, start + 8).map(async (uri) => {
            try {
              if (!(await this.policy.allows(uri, settings))) return undefined;
              const stat = await vscode.workspace.fs.stat(uri);
              if (stat.size > settings.maxFileChars * 2) return undefined;
              const open = vscode.workspace.textDocuments.find(
                (document) => document.uri.toString() === uri.toString(),
              );
              const text = open
                ? open.getText()
                : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
              if (text.length > settings.maxFileChars || text.includes('\0')) return undefined;
              return { path: uri.path, text, version: open?.version ?? 0 };
            } catch {
              return undefined;
            }
          }),
        );
        for (const file of batch)
          if (file && bytes + file.text.length * 2 <= 32 * 1024 * 1024) {
            files.push(file);
            bytes += file.text.length * 2;
          }
      }
      if (epoch !== this.epoch || this.disposed) return;
      this.snapshots.clear();
      for (const file of files) this.snapshots.set(file.path, file);
      this.stats = await this.rpc<IndexStats>('load', { files, configs }, 30000);
      this.publish([]);
    } catch {
      this.stats = { files: 0, symbols: 0, ready: false };
    } finally {
      this.loading = false;
      if (this.restartRequested && !this.disposed) {
        this.restartRequested = false;
        void this.start();
      } else if (this.queued.size && !this.disposed) void this.flush();
    }
  }

  private rpc<T>(method: string, args: unknown, timeout = 150): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker || this.disposed) {
        reject(new Error('索引尚未就绪'));
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('索引查询超时'));
      }, timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }
  async query(uri: vscode.Uri, prefix: string, currentText?: string): Promise<SymbolMatch[]> {
    if (!this.stats.ready || !readSettings(uri).projectIndex) return [];
    try {
      const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.path;
      const matches = await this.rpc<SymbolMatch[]>(
        'query',
        { file: uri.path, prefix, limit: 12, currentText },
        80,
      );
      return matches.filter((match) => root && withinRoot(match.file, root)).slice(0, 6);
    } catch {
      return [];
    }
  }
  observe(document: vscode.TextDocument, learn = true, preserve = false): void {
    if (!this.indexable(document.uri)) return;
    if (!/\.[cm]?[jt]sx?$/.test(document.uri.path) || (!this.stats.ready && !this.loading)) return;
    if (
      !this.snapshots.has(document.uri.path) &&
      this.snapshots.size >= readSettings().indexMaxFiles
    )
      return;
    const old = this.queued.get(document.uri.path);
    this.queued.set(document.uri.path, {
      document,
      learn: (old?.learn ?? true) && learn,
      preserve,
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 350);
  }
  async flush(): Promise<void> {
    if (this.loading || this.disposed) return;
    const items = [...this.queued.values()];
    this.queued.clear();
    for (const { document, learn, preserve } of items) {
      const settings = readSettings(document.uri);
      if (
        !this.policy.isSmall(document, settings) ||
        !(await this.policy.allows(document.uri, settings))
      ) {
        await this.remove(document.uri);
        continue;
      }
      const file = { path: document.uri.path, version: document.version, text: document.getText() };
      if (!this.fits(file)) {
        await this.remove(document.uri);
        continue;
      }
      this.snapshots.set(file.path, file);
      try {
        const result = await this.rpc<{ edits: LinkedEdit[]; stats: IndexStats }>(
          'update',
          { file, learn: learn && settings.linkedEdits, preserve },
          15000,
        );
        this.stats = result.stats;
        this.publish(result.edits);
      } catch {
        /* 索引维护失败不影响正在进行的代码输入。 */
      }
    }
  }
  async refreshFile(uri: vscode.Uri): Promise<void> {
    if (!this.indexable(uri)) return;
    if (!this.stats.ready) return;
    if (!this.snapshots.has(uri.path) && this.snapshots.size >= readSettings().indexMaxFiles)
      return;
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    if (open) {
      if (!this.queued.has(uri.path) && open.getText() !== this.snapshots.get(uri.path)?.text)
        this.observe(open);
      return;
    }
    try {
      const settings = readSettings(uri);
      if (!(await this.policy.allows(uri, settings))) return;
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > settings.maxFileChars * 2) return;
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      if (text.length > settings.maxFileChars) return;
      const file = {
        path: uri.path,
        text,
        version: (this.snapshots.get(uri.path)?.version ?? 0) + 1,
      };
      if (!this.fits(file)) {
        await this.remove(uri);
        return;
      }
      this.snapshots.set(uri.path, file);
      const result = await this.rpc<{ edits: LinkedEdit[]; stats: IndexStats }>(
        'update',
        { file, learn: false },
        15000,
      );
      this.stats = result.stats;
      this.publish(result.edits);
    } catch {
      await this.remove(uri);
    }
  }
  async remove(uri: vscode.Uri): Promise<void> {
    this.snapshots.delete(uri.path);
    try {
      const result = await this.rpc<{ edits: LinkedEdit[]; stats: IndexStats }>(
        'remove',
        { file: uri.path },
        15000,
      );
      this.stats = result.stats;
      this.publish(result.edits);
    } catch {
      /* 文件删除与停止索引可能并发。 */
    }
  }
  snapshot(file: string): IndexedFile | undefined {
    return this.snapshots.get(file);
  }
  /** 增量监听与初始扫描使用同一排除规则，避免把新生成的 dist 再索引进去。 */
  private indexable(uri: vscode.Uri): boolean {
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.path;
    if (!root || !withinRoot(uri.path, root)) return false;
    const relative = uri.path.slice(root.length + 1);
    return !/(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor|artifacts)(\/|$)/.test(
      relative,
    );
  }
  private fits(file: IndexedFile): boolean {
    const size = [...this.snapshots.values()].reduce(
      (sum, entry) => sum + (entry.path === file.path ? 0 : entry.text.length * 2),
      0,
    );
    return size + file.text.length * 2 <= 32 * 1024 * 1024;
  }
  invalidate(): void {
    this.epoch++;
    this.stats.ready = false;
    this.queued.clear();
    this.snapshots.clear();
    this.publish([]);
    this.stopWorker();
    if (this.loading) this.restartRequested = true;
    else void this.start();
  }
  private stopWorker(): void {
    this.stats.ready = false;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('索引已停止'));
    }
    this.pending.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.epoch++;
    clearTimeout(this.timer);
    this.stopWorker();
    this.listeners.clear();
    this.snapshots.clear();
  }
}

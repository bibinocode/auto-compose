import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  config: {} as Record<string, any>,
  inline: undefined as any,
  editor: undefined as any,
  events: {} as Record<string, (...args: any[]) => void>,
  commands: {} as Record<string, (...args: any[]) => unknown>,
}));
vi.mock('vscode', () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
    isEqual(other: Position) {
      return this.line === other.line && this.character === other.character;
    }
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  const noop = () => ({ dispose() {} });
  const event = (id: string) => (cb: (...args: any[]) => void) => {
    mock.events[id] = cb;
    return noop();
  };
  return {
    EventEmitter: class {
      event = noop;
      fire() {}
      dispose() {}
    },
    Position,
    Range,
    Uri: { joinPath: () => ({ fsPath: '/test' }) },
    InlineCompletionItem: class {
      constructor(
        public insertText: string,
        public range: Range,
      ) {}
    },
    StatusBarAlignment: { Right: 1 },
    EndOfLine: { CRLF: 2 },
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 1 },
    workspace: {
      registerTextDocumentContentProvider: noop,
      isTrusted: true,
      getWorkspaceFolder: () => undefined,
      createFileSystemWatcher: () => ({
        dispose() {},
        onDidChange: noop,
        onDidCreate: noop,
        onDidDelete: noop,
      }),
      onDidSaveTextDocument: noop,
      getConfiguration: () => ({
        get: (key: string, fallback: any) => mock.config[key] ?? fallback,
      }),
      onDidChangeConfiguration: event('config'),
      onDidChangeTextDocument: event('document'),
    },
    window: {
      get activeTextEditor() {
        return mock.editor;
      },
      createOutputChannel: () => ({ appendLine: vi.fn(), dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      onDidChangeActiveTextEditor: event('editor'),
      onDidChangeTextEditorSelection: event('selection'),
      showInformationMessage: vi.fn(async () => undefined),
      registerWebviewViewProvider: noop,
    },
    languages: {
      registerCodeLensProvider: noop,
      registerCompletionItemProvider: noop,
      registerInlineCompletionItemProvider: (_: any, provider: any) => {
        mock.inline = provider;
        return noop();
      },
    },
    commands: {
      registerCommand: (id: string, handler: (...args: any[]) => unknown) => {
        mock.commands[id] = handler;
        return noop();
      },
    },
  };
});

import * as vscode from 'vscode';
import { activate } from '../src/extension';

function document(text: string, path = '/project/code.ts') {
  const doc = {
    uri: { path, scheme: 'file', toString: () => `file://${path}` },
    languageId: 'typescript',
    version: 1,
    eol: 1,
    lineCount: text.split('\n').length,
    offsetAt: (p: vscode.Position) =>
      text
        .split('\n')
        .slice(0, p.line)
        .reduce((n, l) => n + l.length + 1, 0) + p.character,
    positionAt: (n: number) => {
      const lines = text.slice(0, n).split('\n');
      return new vscode.Position(lines.length - 1, lines.at(-1)!.length);
    },
    getText: (r?: vscode.Range) =>
      r ? text.slice(doc.offsetAt(r.start), doc.offsetAt(r.end)) : text,
    lineAt: (line: number) => ({
      range: new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, text.split('\n')[line].length),
      ),
    }),
  };
  return doc;
}

describe('VS Code inline completion integration (mock host)', () => {
  let subscriptions: { dispose(): void }[];
  let api: ReturnType<typeof activate>;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
  const request = () =>
    mock.inline.provideInlineCompletionItems(
      mock.editor.document,
      mock.editor.selection.active,
      { triggerKind: 0 },
      token,
    );
  const select = (text: string, offset: number, path?: string) => {
    const doc = document(text, path);
    mock.editor = {
      document: doc,
      selection: { isEmpty: true, active: doc.positionAt(offset) },
      selections: [{}],
    };
  };
  beforeEach(() => {
    mock.config = { provider: 'test', debounceMs: 0, minRequestIntervalMs: 0 };
    mock.events = {};
    mock.editor = undefined;
    subscriptions = [];
    api = activate({
      subscriptions,
      extensionUri: { fsPath: '/test' },
      secrets: { get: async () => undefined, onDidChange: () => ({ dispose() {} }) },
      globalState: { get: () => true, update: vi.fn(async () => {}) },
    } as any);
    select('return ;', 7);
  });
  afterEach(() => {
    subscriptions.forEach((s) => s.dispose());
  });
  it('fills the middle, retains the line tail and uses cache for identical requests', async () => {
    const complete = vi.fn(async () => 'a + b');
    api.registerProvider({ id: 'test', displayName: 'Test', requiresApiKey: false, complete });
    const items = await request();
    expect(items[0].insertText).toBe('a + b;');
    expect(items[0].range.start.character).toBe(7);
    expect(items[0].range.end.character).toBe(8);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'return ', suffix: ';', languageId: 'typescript' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await request();
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('does not call a keyed provider when its key is missing', async () => {
    const complete = vi.fn(async () => 'a');
    api.registerProvider({ id: 'test', displayName: 'Test', complete });
    expect(await request()).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
  it('does not send excluded files or disabled languages', async () => {
    const complete = vi.fn(async () => 'secret');
    api.registerProvider({ id: 'test', displayName: 'Test', requiresApiKey: false, complete });
    select('TOKEN=', 6, '/project/.env.local');
    expect(await request()).toEqual([]);
    select('log ', 4);
    mock.editor.document.languageId = 'log';
    expect(await request()).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
  it('cancels obsolete results after an edit even if provider ignores signal', async () => {
    let resolve!: (text: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    api.registerProvider({
      id: 'test',
      displayName: 'Test',
      requiresApiKey: false,
      complete: () => {
        started();
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    const pending = request();
    await ready;
    mock.editor.document.version++;
    mock.events.document({ document: mock.editor.document, contentChanges: [] });
    expect(await pending).toEqual([]);
    resolve('stale');
  });
  it('clears cache on provider disposal and prevents duplicate registration', async () => {
    const provider = {
      id: 'test',
      displayName: 'Test',
      requiresApiKey: false,
      complete: async () => 'old',
    };
    const handle = api.registerProvider(provider);
    expect(() => api.registerProvider(provider)).toThrow();
    await request();
    handle.dispose();
    api.registerProvider({ ...provider, complete: async () => 'new' });
    expect((await request())[0].insertText).toBe('new;');
  });
  it('在原生 IntelliSense 选中项后追加续写，覆盖正确的单词范围', async () => {
    select('console.lo', 10);
    const complete = vi.fn(async () => '(value)');
    api.registerProvider({ id: 'test', displayName: 'Test', requiresApiKey: false, complete });
    const items = await mock.inline.provideInlineCompletionItems(
      mock.editor.document,
      mock.editor.selection.active,
      {
        triggerKind: 0,
        selectedCompletionInfo: {
          text: 'log',
          range: new vscode.Range(new vscode.Position(0, 8), new vscode.Position(0, 10)),
        },
      },
      token,
    );
    expect(items[0].insertText).toBe('log(value)');
    expect(items[0].range.start.character).toBe(8);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'console.log' }),
      expect.anything(),
    );
  });
  it('多光标编辑不发起补全，避免仅修改其中一个光标', async () => {
    const complete = vi.fn(async () => 'a');
    api.registerProvider({ id: 'test', displayName: 'Test', requiresApiKey: false, complete });
    mock.editor.selections = [{}, {}];
    expect(await request()).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});

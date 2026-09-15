import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  ignoreText: '',
  documents: [] as any[],
  definitions: [] as any[],
  definitionCommand: vi.fn(),
  files: new Map<string, any>(),
}));
vi.mock('vscode', () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  const uri = (path: string) => ({ path, scheme: 'file', toString: () => `file://${path}` });
  return {
    Position,
    Range,
    Uri: { joinPath: (base: { path: string }, name: string) => uri(base.path + '/' + name) },
    workspace: {
      getWorkspaceFolder: (value: { path: string }) =>
        value.path.startsWith('/workspace/') ? { uri: uri('/workspace') } : undefined,
      get textDocuments() {
        return mock.documents;
      },
      fs: {
        readFile: async () => new TextEncoder().encode(mock.ignoreText),
        stat: async () => ({ size: 100 }),
      },
      openTextDocument: async (value: { path: string }) => mock.files.get(value.path),
    },
    commands: {
      executeCommand: (...args: unknown[]) => {
        mock.definitionCommand(...args);
        return Promise.resolve(mock.definitions);
      },
    },
  };
});

import * as vscode from 'vscode';
import { FilePolicy } from '../src/context/filePolicy';
import { ContextService } from '../src/context/contextService';
import type { Settings } from '../src/config/settings';

function doc(path: string, text: string): any {
  const document = {
    uri: { path, scheme: 'file', toString: () => `file://${path}` },
    languageId: 'typescript',
    lineCount: text.split('\n').length,
    offsetAt: (p: vscode.Position) =>
      text
        .split('\n')
        .slice(0, p.line)
        .reduce((n, line) => n + line.length + 1, 0) + p.character,
    positionAt: (offset: number) => {
      const lines = text.slice(0, offset).split('\n');
      return new vscode.Position(lines.length - 1, lines.at(-1)!.length);
    },
    lineAt: (line: number) => ({
      range: new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, text.split('\n')[line].length),
      ),
    }),
    getText: (range?: vscode.Range) =>
      range ? text.slice(document.offsetAt(range.start), document.offsetAt(range.end)) : text,
  };
  return document;
}
const settings = {
  prefixChars: 12000,
  suffixChars: 4000,
  maxTokens: 256,
  contextChars: 800,
  contextMode: 'open-files',
  useDefinitions: false,
  maxFileChars: 5000,
  disabledLanguages: [],
  excludePatterns: ['**/.env*'],
} as unknown as Settings;

describe('上下文文件边界', () => {
  beforeEach(() => {
    mock.ignoreText = '';
    mock.documents = [];
    mock.definitions = [];
    mock.files.clear();
    mock.definitionCommand.mockClear();
  });
  it('遵守 ignore 否定规则和默认敏感文件 glob', async () => {
    mock.ignoreText = 'private/*\n!private/public.ts';
    const policy = new FilePolicy();
    expect(await policy.allows(doc('/workspace/private/key.ts', '').uri, settings)).toBe(false);
    expect(await policy.allows(doc('/workspace/private/public.ts', '').uri, settings)).toBe(true);
    expect(await policy.allows(doc('/workspace/.env.local', '').uri, settings)).toBe(false);
  });
  it('仅选同工作区内最近访问、未排除的文件，并限制总预算', async () => {
    const policy = new FilePolicy();
    const context = new ContextService(policy);
    const current = doc('/workspace/main.ts', 'const result = calculateInvoice(');
    const allowed = doc(
      '/workspace/invoice.ts',
      'function calculateInvoice(customer) { return customer.total; }',
    );
    const excluded = doc('/workspace/.env', 'private token');
    const outside = doc('/other/shared.ts', 'outside secret');
    mock.documents = [current, allowed, excluded, outside];
    for (const document of mock.documents) context.record(document, 0);
    const result = await context.collect(
      current,
      current.positionAt(32),
      settings,
      new AbortController().signal,
    );
    expect(result.context?.map((item) => item.filepath)).toEqual(['invoice.ts']);
    expect(result.context?.[0].content).toContain('calculateInvoice');
    expect(result.context!.reduce((n, item) => n + item.content.length, 0)).toBeLessThanOrEqual(
      800,
    );
  });
  it('默认当前文件模式不调用语言服务，也不读取关联文件', async () => {
    const current = doc('/workspace/main.ts', 'const value = ');
    const context = new ContextService(new FilePolicy());
    const result = await context.collect(
      current,
      current.positionAt(14),
      { ...settings, contextMode: 'current-file' },
      new AbortController().signal,
    );
    expect(result.context).toBeUndefined();
    expect(mock.definitionCommand).not.toHaveBeenCalled();
  });
  it('定义检索只采集工作区内且未排除的目标', async () => {
    const current = doc('/workspace/main.ts', 'calculateInvoice(');
    const target = doc(
      '/workspace/invoice.ts',
      'function calculateInvoice(customer) { return 1; }',
    );
    mock.files.set(target.uri.path, target);
    mock.definitions = [
      {
        uri: target.uri,
        range: new vscode.Range(new vscode.Position(0, 0), target.positionAt(49)),
      },
      { uri: doc('/outside/private.ts', '').uri, range: target.lineAt(0).range },
    ];
    const context = new ContextService(new FilePolicy());
    const result = await context.collect(
      current,
      current.positionAt(17),
      { ...settings, contextMode: 'current-file', useDefinitions: true },
      new AbortController().signal,
    );
    expect(result.context?.length).toBe(1);
    expect(result.context?.[0].source).toBe('definition');
  });
});

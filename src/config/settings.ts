import * as vscode from 'vscode';

/** 默认值与 package.json 通过测试校验，避免 UI 和运行时出现不同默认行为。 */
export const defaults = {
  projectIndex: true,
  projectContext: true,
  indexMaxFiles: 1500,
  linkedEdits: true,
  enabled: true,
  provider: 'deepseek',
  baseUrl: '',
  model: '',
  protocol: 'fim',
  debounceMs: 150,
  maxTokens: 256,
  timeoutMs: 15000,
  prefixChars: 12000,
  suffixChars: 4000,
  streaming: true,
  multiline: 'auto',
  maxLines: 12,
  minRequestIntervalMs: 250,
  contextMode: 'current-file',
  contextChars: 4000,
  useDefinitions: false,
  maxFileChars: 500000,
  cacheEnabled: true,
  disabledLanguages: ['log', 'scminput'],
  excludePatterns: [
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/node_modules/**',
    '**/.git/**',
  ],
};

export interface Settings {
  projectIndex: boolean;
  projectContext: boolean;
  indexMaxFiles: number;
  linkedEdits: boolean;
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  protocol: 'fim' | 'chat';
  debounceMs: number;
  maxTokens: number;
  timeoutMs: number;
  prefixChars: number;
  suffixChars: number;
  streaming: boolean;
  multiline: 'auto' | 'always' | 'never';
  maxLines: number;
  minRequestIntervalMs: number;
  contextMode: 'current-file' | 'open-files';
  contextChars: number;
  useDefinitions: boolean;
  maxFileChars: number;
  cacheEnabled: boolean;
  disabledLanguages: string[];
  excludePatterns: string[];
}

/** 设置来自 JSON 或 Webview 时都可能越界，运行时仍执行类型校验与范围限制。 */
export function readSettings(uri?: vscode.Uri): Settings {
  const c = vscode.workspace.getConfiguration('autoCompose', uri);
  const text = (key: string, fallback: string) => {
    const value = c.get<unknown>(key, fallback);
    return typeof value === 'string' ? value.trim() : fallback;
  };
  const bool = (key: keyof typeof defaults) => {
    const value = c.get(key, defaults[key]);
    return typeof value === 'boolean' ? value : Boolean(defaults[key]);
  };
  const integer = (key: keyof typeof defaults, min: number, max: number) => {
    const value = c.get(key, defaults[key]);
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.floor(value)))
      : Number(defaults[key]);
  };
  const strings = (key: 'excludePatterns' | 'disabledLanguages') => {
    const value = c.get<unknown>(key, defaults[key]);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : defaults[key];
  };
  const multiline = text('multiline', 'auto');
  return {
    projectIndex: bool('projectIndex'),
    projectContext: bool('projectContext'),
    indexMaxFiles: integer('indexMaxFiles', 100, 10000),
    linkedEdits: bool('linkedEdits'),
    enabled: bool('enabled'),
    provider: text('provider', 'deepseek'),
    baseUrl: text('baseUrl', '') || 'https://api.deepseek.com/beta',
    model: text('model', '') || 'deepseek-flash',
    protocol: text('protocol', 'fim') === 'chat' ? 'chat' : 'fim',
    debounceMs: integer('debounceMs', 0, 3000),
    maxTokens: integer('maxTokens', 1, 4096),
    timeoutMs: integer('timeoutMs', 1000, 120000),
    prefixChars: integer('prefixChars', 256, 64000),
    suffixChars: integer('suffixChars', 0, 32000),
    streaming: bool('streaming'),
    multiline: multiline === 'always' || multiline === 'never' ? multiline : 'auto',
    maxLines: integer('maxLines', 1, 50),
    minRequestIntervalMs: integer('minRequestIntervalMs', 0, 10000),
    contextMode:
      text('contextMode', 'current-file') === 'open-files' ? 'open-files' : 'current-file',
    contextChars: integer('contextChars', 0, 16000),
    useDefinitions: bool('useDefinitions'),
    maxFileChars: integer('maxFileChars', 1000, 5000000),
    cacheEnabled: bool('cacheEnabled'),
    disabledLanguages: strings('disabledLanguages'),
    excludePatterns: strings('excludePatterns'),
  };
}

import { CompletionError } from '../core';
import { completionUrl } from '../providers/http';

export const panelCommands = new Set([
  'setApiKey',
  'refreshBalance',
  'deleteApiKey',
  'testConnection',
  'toggle',
  'pause',
  'resume',
  'openSettings',
  'showOutput',
  'clearCache',
  'diagnostics',
  'previewLinkedEdit',
  'rebuildIndex',
  'indexStatus',
]);
export type PanelSettings = Record<string, string | number | boolean>;

/** Webview 不可信任其消息形状；只接受已声明的设置，禁止任意命令与配置写入。 */
export function validatePanelSettings(value: unknown, providerIds: string[]): PanelSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CompletionError('设置格式无效。');
  const input = value as Record<string, unknown>;
  const result: PanelSettings = {};
  const enums: Record<string, string[]> = {
    provider: providerIds,
    protocol: ['fim', 'chat'],
    multiline: ['auto', 'always', 'never'],
    contextMode: ['current-file', 'open-files'],
  };
  const limits: Record<string, [number, number]> = {
    debounceMs: [0, 3000],
    minRequestIntervalMs: [0, 10000],
    maxTokens: [1, 4096],
    timeoutMs: [1000, 120000],
    maxLines: [1, 50],
    contextChars: [0, 16000],
  };
  for (const [key, entry] of Object.entries(input)) {
    if (enums[key] && typeof entry === 'string' && enums[key].includes(entry)) result[key] = entry;
    else if (
      limits[key] &&
      typeof entry === 'number' &&
      Number.isInteger(entry) &&
      entry >= limits[key][0] &&
      entry <= limits[key][1]
    )
      result[key] = entry;
    else if (['baseUrl', 'model'].includes(key) && typeof entry === 'string' && entry.length < 2048)
      result[key] = entry.trim();
    else if (
      [
        'streaming',
        'useDefinitions',
        'cacheEnabled',
        'projectIndex',
        'projectContext',
        'linkedEdits',
      ].includes(key) &&
      typeof entry === 'boolean'
    )
      result[key] = entry;
    else throw new CompletionError(`设置 ${key} 不受支持或数值无效。`);
  }
  if (typeof result.baseUrl === 'string' && result.baseUrl)
    completionUrl(result.baseUrl, result.protocol === 'chat' ? 'chat' : 'fim');
  if (result.provider === 'openai-compatible' && (!result.baseUrl || !result.model))
    throw new CompletionError('自定义服务必须填写基础 URL 和模型。');
  return result;
}

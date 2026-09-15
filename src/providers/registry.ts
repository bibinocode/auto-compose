import type { CompletionProvider } from '../api';
import type { Settings } from '../config/settings';
import { CompletionError } from '../core';
import { HttpCompletionProvider } from './http';

/** Provider 注册和配置解析集中管理；注销后触发请求与缓存失效。 */
export class ProviderRegistry {
  private readonly entries = new Map<string, CompletionProvider>();
  private disposed = false;
  constructor(private readonly changed: () => void) {}
  list(): { id: string; displayName: string }[] {
    return [
      { id: 'deepseek', displayName: 'DeepSeek' },
      { id: 'openai-compatible', displayName: 'OpenAI 兼容接口' },
      ...this.entries.values(),
    ].map(({ id, displayName }) => ({ id, displayName }));
  }
  resolve(settings: Settings): CompletionProvider {
    if (['deepseek', 'openai-compatible'].includes(settings.provider)) {
      return new HttpCompletionProvider({
        id: settings.provider,
        baseUrl: settings.baseUrl,
        model: settings.model,
        protocol: settings.provider === 'deepseek' ? 'fim' : settings.protocol,
      });
    }
    const provider = this.entries.get(settings.provider);
    if (!provider) throw new CompletionError('Provider 未注册，请检查设置或启用对应扩展。');
    return provider;
  }
  register(provider: CompletionProvider): { dispose(): void } {
    if (
      this.disposed ||
      !/^[\w.-]+$/.test(provider.id) ||
      !provider.displayName ||
      typeof provider.complete !== 'function' ||
      (provider.stream !== undefined && typeof provider.stream !== 'function') ||
      this.list().some((entry) => entry.id === provider.id)
    ) {
      throw new Error('Provider ID 无效、重复或为内置保留名称。');
    }
    this.entries.set(provider.id, provider);
    this.changed();
    return {
      dispose: () => {
        if (this.entries.get(provider.id) === provider) {
          this.entries.delete(provider.id);
          this.changed();
        }
      },
    };
  }
  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }
}

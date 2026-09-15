import { createHash } from 'node:crypto';
import type { CompletionProvider, CompletionRequest, ProviderContext } from '../api';
import type { Settings } from '../config/settings';
import { abortable, CompletionCache, CompletionError, delay } from '../core';
import { Session } from '../services/session';
import { lineLimit, postprocess, truncateLines } from './postprocess';
import { CompletionReuse } from './reuse';
import { qualityIssue } from './intent';

export interface GenerationInput {
  request: CompletionRequest;
  settings: Settings;
  provider: CompletionProvider;
  apiKey?: string;
  documentId: string;
  offset: number;
  eol: string;
  signal: AbortSignal;
  /** 从编辑器触发时计算的防抖截止时间；上下文检索可消耗这段等待。 */
  notBefore?: number;
}

/** 与编辑器解耦的生成引擎：缓存 → 续写复用 → 节流 → 生成 → 后处理。 */
export class CompletionEngine {
  private readonly cache = new CompletionCache();
  private readonly reuse = new CompletionReuse();
  private readonly emptyCache = new CompletionCache(32, 2000);
  private readonly health = new Map<string, { lastRequest: number; cooldownUntil: number }>();
  constructor(private readonly session: Session) {}
  clear(): void {
    this.cache.clear();
    this.reuse.clear();
    this.emptyCache.clear();
    this.health.clear();
  }

  async generate(
    input: GenerationInput,
  ): Promise<{ text: string; source: 'network' | 'cache' | 'reuse'; rejection?: string }> {
    const { request, settings, provider, signal } = input;
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    this.session.stats.lastWaitMs = 0;
    const scope = JSON.stringify([
      settings.provider,
      settings.baseUrl,
      settings.model,
      settings.protocol,
      input.documentId,
      settings.multiline,
      settings.maxLines,
      request.context,
    ]);
    const reuseInput = {
      scope,
      prefix: request.prefix,
      suffix: request.suffix,
      offset: input.offset,
      prefixChars: settings.prefixChars,
    };
    const key = createHash('sha256')
      .update(JSON.stringify([scope, request, input.eol]))
      .digest('hex');
    if (settings.cacheEnabled) {
      const reused = this.reuse.get(reuseInput);
      if (reused) {
        this.session.stats.cacheHits++;
        return { text: reused, source: 'reuse' };
      }
      const cached = this.cache.get(key);
      if (cached !== undefined || this.emptyCache.get(key) !== undefined) {
        this.session.stats.cacheHits++;
        if (cached) this.reuse.set(reuseInput, cached);
        return { text: cached ?? '', source: 'cache' };
      }
    }

    const endpoint = JSON.stringify([settings.provider, settings.baseUrl, settings.model]);
    const health = this.health.get(endpoint) ?? { lastRequest: 0, cooldownUntil: 0 };
    if (health.cooldownUntil > Date.now())
      throw new CompletionError(
        `服务冷却中，${Math.ceil((health.cooldownUntil - Date.now()) / 1000)} 秒后恢复。`,
        429,
        health.cooldownUntil - Date.now(),
      );
    // 防抖与节流使用同一截止时间，不能串行叠加；命中缓存完全跳过网络等待。
    const waiting = Date.now();
    const waitMs = Math.max(
      0,
      Math.max(input.notBefore ?? 0, health.lastRequest + settings.minRequestIntervalMs) - waiting,
    );
    if (waitMs > 0) {
      this.session.set('debouncing', '等待输入停顿或服务间隔');
      await delay(waitMs, signal);
    }
    this.session.stats.lastWaitMs = Date.now() - waiting;
    health.lastRequest = Date.now();
    this.health.set(endpoint, health);

    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.timeoutMs);
    const accounting = this.session.beginUsage();
    const context: ProviderContext = {
      apiKey: input.apiKey,
      signal: controller.signal,
      onUsage: accounting.report,
    };
    const start = Date.now();
    let firstToken = 0;
    const maxLines = lineLimit(request.prefix, settings, request.languageId);
    this.session.stats.requests++;
    this.session.set('loading', '正在生成代码');
    try {
      let raw = '';
      if (settings.streaming && provider.stream) {
        const iterator = provider.stream(request, context)[Symbol.asyncIterator]();
        try {
          while (true) {
            const chunk = await abortable(Promise.resolve(iterator.next()), controller.signal);
            if (chunk.done) break;
            if (typeof chunk.value !== 'string')
              throw new CompletionError('Provider 的流式输出必须是字符串。');
            if (!raw && chunk.value) firstToken = Date.now() - start;
            raw += chunk.value;
            const code = raw.replace(/^```[^\n]*\n/, '');
            // 只在取得完整行或达到字符上限时提前停止，不能在网络 chunk 边界截断代码。
            if (
              (!code.startsWith('```') && truncateLines(code, maxLines).complete) ||
              raw.length >= 32768
            ) {
              raw = raw.slice(0, 32768);
              break;
            }
          }
        } finally {
          controller.abort();
          // 第三方迭代器可能忽略 signal，释放请求时不能无限等待 return()。
          if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
        }
      } else {
        raw = await abortable(provider.complete(request, context), controller.signal);
        if (typeof raw !== 'string') throw new CompletionError('Provider 返回值必须是字符串。');
        raw = raw.slice(0, 32768);
        firstToken = Date.now() - start;
      }
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const text = postprocess(
        raw,
        request.prefix,
        request.suffix,
        input.eol,
        maxLines,
        request.languageId,
      );
      const rejected = qualityIssue(
        raw.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, ''),
        request.prefix,
        request.languageId,
      );
      if (rejected) this.session.stats.rejected++;
      this.session.generated(Date.now() - start, firstToken);
      if (settings.cacheEnabled && text) {
        this.cache.set(key, text);
        this.reuse.set(reuseInput, text);
      }
      // 短暂记住空结果，避免编辑器在同一位置反复触发计费请求；编辑内容变化立即失配。
      if (settings.cacheEnabled && !text) this.emptyCache.set(key, '');
      return { text, source: 'network', ...(rejected ? { rejection: rejected } : {}) };
    } catch (error) {
      if (timedOut && !signal.aborted)
        throw new CompletionError('补全请求超时，可调整 timeoutMs 或减少生成长度。');
      if (
        error instanceof CompletionError &&
        error.status &&
        (error.status === 429 ||
          error.status >= 500 ||
          error.status === 401 ||
          error.status === 403)
      ) {
        health.cooldownUntil =
          Date.now() + Math.max(error.retryAfterMs, error.status === 429 ? 30000 : 10000);
      }
      throw error;
    } finally {
      accounting.finish();
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
}

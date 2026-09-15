import { describe, expect, it, vi } from 'vitest';
import { CompletionEngine } from '../src/completion/engine';
import { CompletionReuse } from '../src/completion/reuse';
import { mergeLineTail, postprocess, lineLimit } from '../src/completion/postprocess';
import { Session } from '../src/services/session';
import type { Settings } from '../src/config/settings';
import { CompletionError } from '../src/core';

const settings: Settings = {
  projectIndex: true,
  projectContext: true,
  indexMaxFiles: 1500,
  linkedEdits: true,
  enabled: true,
  provider: 'test',
  baseUrl: 'https://example.test',
  model: 'coder',
  protocol: 'fim',
  debounceMs: 0,
  maxTokens: 256,
  timeoutMs: 1000,
  prefixChars: 12000,
  suffixChars: 4000,
  streaming: true,
  multiline: 'auto',
  maxLines: 12,
  minRequestIntervalMs: 0,
  contextMode: 'current-file',
  contextChars: 4000,
  useDefinitions: false,
  maxFileChars: 500000,
  cacheEnabled: true,
  disabledLanguages: [],
  excludePatterns: [],
};

describe('补全后处理与复用', () => {
  it('消除行尾自动闭合重复，但保留真正的嵌套括号', () => {
    expect(mergeLineTail('a + b;', ';')).toBe('a + b;');
    expect(mergeLineTail('inner()', '))')).toBe('inner()))');
    expect(mergeLineTail('inner())', ')')).toBe('inner())');
  });
  it('保留缩进，移除包装、重复前后文和无意义重复行', () => {
    expect(postprocess('```ts\n  return a;\n}\n```', '', '', '\r\n', 12)).toBe('  return a;\r\n}');
    expect(postprocess('const result = foo()', 'const result = ', '', '\n', 12)).toBe('foo()');
    expect(postprocess('value\nreturn result;', 'const x = ', '\nreturn result;', '\n', 12)).toBe(
      'value',
    );
    expect(postprocess('x();\n'.repeat(8), '', '', '\n', 12)).toBe('');
  });
  it('智能生成模式区分表达式和块开头', () => {
    expect(lineLimit('# TODO: 写一下斐波函数\ndef ', settings)).toBe(12);
    expect(lineLimit('# 计算斐波那契\nasync def fib', settings)).toBe(12);
    expect(lineLimit('# TODO: 实现算法\n\n', settings)).toBe(12);
    expect(lineLimit('# TODO: 实现算法\ndef ', { ...settings, multiline: 'never' })).toBe(1);
    expect(lineLimit('const n = ', settings)).toBe(1);
    expect(lineLimit('function run() {', settings)).toBe(12);
    expect(lineLimit('function run() {\n  ', settings)).toBe(12);
    expect(lineLimit('anything', { ...settings, multiline: 'always' })).toBe(12);
  });
  it('支持上下文窗口滑动后的继续输入，拒绝退格、改写及跨文件复用', () => {
    const reuse = new CompletionReuse();
    const input = { scope: 'file-A', prefix: 'return ', suffix: ';', offset: 20, prefixChars: 7 };
    reuse.set(input, 'alpha + beta');
    expect(reuse.get({ ...input, prefix: 'rn alph', offset: 24 })).toBe('a + beta');
    expect(reuse.get({ ...input, prefix: 'rn beta', offset: 24 })).toBeUndefined();
    expect(reuse.get({ ...input, scope: 'file-B' })).toBeUndefined();
    expect(reuse.get({ ...input, offset: 19 })).toBeUndefined();
  });
});

describe('生成引擎', () => {
  const input = (provider: any, overrides: Partial<Settings> = {}) => ({
    request: { prefix: 'return ', suffix: ';', languageId: 'typescript', maxTokens: 256 },
    settings: { ...settings, ...overrides },
    provider,
    documentId: 'file:///test.ts',
    offset: 7,
    eol: '\n',
    signal: new AbortController().signal,
  });
  it('Python TODO 加未完成 def 保留多行函数体与原始上下文', async () => {
    const session = new Session();
    const engine = new CompletionEngine(session);
    const prefix = '# TODO: 写一下斐波函数\ndef ';
    const code = 'fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)';
    const complete = vi.fn(async () => code);
    const args = input({ id: 'test', displayName: 'test', complete });
    args.request = { prefix, suffix: '\n# 下方调用示例', languageId: 'python', maxTokens: 256 };
    expect((await engine.generate(args)).text).toBe(code);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining(args.request), expect.anything());
    session.dispose();
  });
  it('真实用量快照去重，重载保留，缓存不重复计费，缺失用量单独计数', async () => {
    const save = vi.fn();
    const session = new Session(undefined, save);
    const engine = new CompletionEngine(session);
    const usage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };
    const provider = {
      id: 'test',
      displayName: 'test',
      complete: async (_: unknown, context: any) => {
        context.onUsage(usage);
        context.onUsage(usage);
        return 'alpha';
      },
    };
    await engine.generate(input(provider));
    await engine.generate(input(provider));
    expect(session.usage).toEqual({ ...usage, unknownRequests: 0 });
    const missing = session.beginUsage();
    missing.finish();
    missing.finish();
    expect(session.usage.unknownRequests).toBe(1);
    const restored = new Session(save.mock.lastCall![0]);
    expect(restored.usage).toEqual(session.usage);
    session.dispose();
    restored.dispose();
  });
  it('流式到达行数上限后提前停止，并关闭下游 signal', async () => {
    const session = new Session();
    const engine = new CompletionEngine(session);
    let closed = false;
    let signal: AbortSignal | undefined;
    const provider = {
      id: 'test',
      displayName: 'test',
      complete: vi.fn(),
      async *stream(_: unknown, context: { signal: AbortSignal }) {
        signal = context.signal;
        try {
          yield 'alpha';
          yield ' + beta\n';
          yield 'should not be consumed';
        } finally {
          closed = true;
        }
      },
    };
    const result = await engine.generate(input(provider));
    expect(result.text).toBe('alpha + beta');
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(true);
    expect(provider.complete).not.toHaveBeenCalled();
    session.dispose();
  });
  it('防抖使用触发截止时间，检索耗时不叠加；缓存复用不等待', async () => {
    vi.useFakeTimers();
    const session = new Session();
    try {
      const engine = new CompletionEngine(session);
      const complete = vi.fn(async () => 'alpha');
      const args = input({ id: 'test', displayName: 'test', complete });
      const triggered = Date.now();
      await vi.advanceTimersByTimeAsync(80); // 模拟上下文检索消耗防抖窗口。
      const pending = engine.generate({ ...args, notBefore: triggered + 150 });
      await vi.advanceTimersByTimeAsync(69);
      expect(complete).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).text).toBe('alpha');
      expect(Date.now() - triggered).toBe(150);
      const cachedAt = Date.now();
      expect((await engine.generate({ ...args, notBefore: Date.now() + 3000 })).source).toBe(
        'reuse',
      );
      expect(Date.now()).toBe(cachedAt);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      session.dispose();
    }
  });
  it('相同空结果短暂去重，编辑变化与过期允许重新生成', async () => {
    vi.useFakeTimers();
    const session = new Session();
    try {
      const engine = new CompletionEngine(session);
      const complete = vi.fn(async () => '');
      const args = input({ id: 'test', displayName: 'test', complete });
      await engine.generate(args);
      expect((await engine.generate(args)).source).toBe('cache');
      expect(complete).toHaveBeenCalledTimes(1);
      await engine.generate({ ...args, request: { ...args.request, prefix: 'return x' } });
      expect(complete).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2001);
      await engine.generate(args);
      expect(complete).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      session.dispose();
    }
  });
  it('等待期间取消不会发送请求，也不会记成未知用量', async () => {
    vi.useFakeTimers();
    const session = new Session();
    try {
      const complete = vi.fn(async () => 'alpha');
      const controller = new AbortController();
      const pending = new CompletionEngine(session).generate({
        ...input({ id: 'test', displayName: 'test', complete }),
        signal: controller.signal,
        notBefore: Date.now() + 150,
      });
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await assertion;
      expect(complete).not.toHaveBeenCalled();
      expect(session.usage.unknownRequests).toBe(0);
    } finally {
      vi.useRealTimers();
      session.dispose();
    }
  });
  it('输入命中已有候选时不重复请求', async () => {
    const session = new Session();
    const engine = new CompletionEngine(session);
    const provider = {
      id: 'test',
      displayName: 'test',
      complete: vi.fn(async () => 'alpha + beta'),
    };
    const first = input(provider);
    await engine.generate(first);
    const result = await engine.generate({
      ...first,
      offset: 12,
      request: { ...first.request, prefix: 'return alpha' },
    });
    expect(result).toEqual({ text: ' + beta', source: 'reuse' });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    session.dispose();
  });
  it('限流后进入冷却，不对每次键入重复调用服务', async () => {
    const session = new Session();
    const engine = new CompletionEngine(session);
    const provider = {
      id: 'test',
      displayName: 'test',
      complete: vi.fn(async () => {
        throw new CompletionError('限流', 429, 60000);
      }),
    };
    await expect(engine.generate(input(provider))).rejects.toThrow('限流');
    await expect(engine.generate(input(provider))).rejects.toThrow('冷却');
    expect(provider.complete).toHaveBeenCalledTimes(1);
    session.dispose();
  });
  it('第三方 Provider 永不返回时仍能超时结束', async () => {
    const session = new Session();
    const engine = new CompletionEngine(session);
    vi.useFakeTimers();
    try {
      const provider = {
        id: 'test',
        displayName: 'test',
        complete: () => new Promise<string>(() => {}),
      };
      const assertion = expect(engine.generate(input(provider))).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(1100);
      await assertion;
    } finally {
      vi.useRealTimers();
      session.dispose();
    }
  });
  it('接受统计按候选 ID 去重，不保留代码', () => {
    const session = new Session();
    session.offer('candidate', 42);
    session.accept('candidate');
    session.accept('candidate');
    expect(session.stats.accepted).toBe(1);
    expect(session.stats.acceptedCharacters).toBe(42);
    session.dispose();
  });
});

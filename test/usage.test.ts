import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpCompletionProvider } from '../src/providers/http';

const provider = () =>
  new HttpCompletionProvider({
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com/beta',
    model: 'deepseek-flash',
    protocol: 'fim',
  });
const request = {
  prefix: '# 斐波那契函数\ndef ',
  suffix: '\n# 调用示例',
  languageId: 'python',
  maxTokens: 256,
};
const context = () => ({
  apiKey: 'fixture',
  signal: new AbortController().signal,
  onUsage: vi.fn(),
});
afterEach(() => vi.unstubAllGlobals());

describe('真实用量协议与账户余额', () => {
  it('JSON 保留注释前后文并提取真实 token', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        choices: [{ text: 'fib(n):\n    return n' }],
        usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const ctx = context();
    await provider().complete(request, ctx);
    expect(ctx.onUsage).toHaveBeenCalledWith({
      promptTokens: 21,
      completionTokens: 9,
      totalTokens: 30,
    });
    const body = JSON.parse(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.prompt.endsWith(request.prefix)).toBe(true);
    expect(body.suffix).toBe(request.suffix);
  });
  it('SSE 无文本尾帧上报 usage，流式 JSON 回退也上报', async () => {
    const payload =
      'data: {"choices":[{"text":"fib(n):"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}\n\ndata: [DONE]\n\n';
    const fetcher = vi.fn(
      async () => new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const ctx = context();
    const chunks = [];
    for await (const text of provider().stream(request, ctx)) chunks.push(text);
    expect(chunks.join('')).toBe('fib(n):');
    expect(ctx.onUsage).toHaveBeenCalledWith({
      promptTokens: 20,
      completionTokens: 4,
      totalTokens: 24,
    });
    const body = JSON.parse(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.stream_options.include_usage).toBe(true);
    vi.stubGlobal('fetch', async () =>
      Response.json({
        choices: [{ text: 'fib' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    for await (const _ of provider().stream(request, ctx)) {
      /* 消费 JSON 回退 */
    }
    expect(ctx.onUsage).toHaveBeenLastCalledWith({
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    });
  });
  it('余额从官方路径获取，保留币种和小数精度，拒绝自定义网关', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '12.340000' }] }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await provider().getBalance(context())).toEqual([
      { currency: 'CNY', total: '12.340000' },
    ]);
    expect(String((fetcher.mock.calls[0] as unknown as [URL])[0])).toBe(
      'https://api.deepseek.com/user/balance',
    );
    const custom = new HttpCompletionProvider({
      id: 'deepseek',
      baseUrl: 'https://example.test',
      model: 'm',
      protocol: 'fim',
    });
    await expect(custom.getBalance(context())).rejects.toThrow('不支持');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('拒绝错误余额响应，不暴露服务响应正文', async () => {
    vi.stubGlobal('fetch', async () => new Response('private fixture', { status: 401 }));
    await expect(provider().getBalance(context())).rejects.toThrow('HTTP 401');
    vi.stubGlobal('fetch', async () =>
      Response.json({ balance_infos: [{ currency: 'CNY', total_balance: 'invalid' }] }),
    );
    await expect(provider().getBalance(context())).rejects.toThrow('格式无效');
  });
});

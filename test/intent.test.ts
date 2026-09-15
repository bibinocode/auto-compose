import { afterEach, describe, expect, it, vi } from 'vitest';
import { implementationIntent, qualityIssue } from '../src/completion/intent';
import { postprocess } from '../src/completion/postprocess';
import { HttpCompletionProvider } from '../src/providers/http';

const prefix =
  '// TODO: 实现一个人机交互的Harness智能体\n// 该智能体可以接收用户的输入，并输出一个响应\nfunction HarnessAgent() {\n  ';
const request = { prefix, suffix: '\n}', languageId: 'javascript', maxTokens: 256, maxLines: 12 };
const provider = (baseUrl = 'https://api.deepseek.com/beta') =>
  new HttpCompletionProvider({ id: 'deepseek', baseUrl, model: 'deepseek-flash', protocol: 'fim' });
afterEach(() => vi.unstubAllGlobals());

describe('需求意图、协议路由与质量拦截', () => {
  it('保留需求说明与输入输出约束，普通变量/已结束函数不路由', () => {
    expect(implementationIntent(prefix, 'javascript')).toContain('接收用户的输入');
    expect(implementationIntent(prefix + "this.name = 'Harness';\n", 'javascript')).toContain(
      'TODO',
    );
    expect(implementationIntent(prefix + '}\nconst value = ', 'javascript')).toBeUndefined();
    expect(implementationIntent('const todo = "TODO: 实现";', 'javascript')).toBeUndefined();
    expect(implementationIntent('// 单价\nconst value = ', 'javascript')).toBeUndefined();
  });
  it('官方实现需求只发一次 Chat 请求，关闭思考，保留上下文及 usage', async () => {
    const fetcher = vi.fn(async (_url: unknown, _options: RequestInit) =>
      Response.json({
        choices: [{ message: { content: 'this.respond = input => input;' } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const onUsage = vi.fn();
    expect(
      await provider().complete(request, { signal: new AbortController().signal, onUsage }),
    ).toContain('respond');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(options.body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(256);
    expect(body.messages[0].content).toContain('12 lines');
    expect(JSON.parse(body.messages[1].content)).toMatchObject({ prefix, suffix: '\n}' });
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
    });
  });
  it('普通补全与第三方端点继续使用 FIM，不增加重试', async () => {
    const fetcher = vi.fn(async (_url: unknown, _options: RequestInit) =>
      Response.json({ choices: [{ text: 'value' }] }),
    );
    vi.stubGlobal('fetch', fetcher);
    await provider().complete(
      { ...request, prefix: 'return ' },
      { signal: new AbortController().signal },
    );
    await provider('https://example.test/beta').complete(request, {
      signal: new AbortController().signal,
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.deepseek.com/beta/completions');
    expect(fetcher.mock.calls[1][0]).toBe('https://example.test/beta/completions');
  });
  it('Chat 路由 SSE 正确解析 delta 与用量，不按 FIM text 读取', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"this.respond = input => input;"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const onUsage = vi.fn();
    const chunks = [];
    for await (const chunk of provider().stream(request, {
      signal: new AbortController().signal,
      onUsage,
    }))
      chunks.push(chunk);
    expect(chunks.join('')).toContain('respond');
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
  it('拒绝元数据漂移、重复块与夹杂围栏，保留合理状态及显式元数据需求', () => {
    const fields = ['author', 'license', 'homepage', 'repository']
      .map((name) => `this.${name} = '';`)
      .join('\n');
    expect(qualityIssue(fields, prefix, 'javascript')).toContain('元数据');
    expect(postprocess(fields, prefix, '', '\n', 12, 'javascript')).toBe('');
    expect(
      qualityIssue(fields, '// TODO: 实现 package 元数据\nfunction Package() {', 'javascript'),
    ).toBeUndefined();
    expect(
      qualityIssue('this.name = "Harness";\nthis.respond = input => input;', prefix, 'javascript'),
    ).toBeUndefined();
    expect(
      qualityIssue('this.a = {};\nthis.b = {};\nthis.a = {};\nthis.b = {};', prefix, 'javascript'),
    ).toContain('重复');
    expect(
      qualityIssue(
        'this.name = "x";\n```javascript\nthis.run = () => 1;\n```',
        prefix,
        'javascript',
      ),
    ).toContain('Markdown');
    expect(postprocess('```js\nthis.respond = input => input;\n```', prefix, '', '\n', 12)).toBe(
      'this.respond = input => input;',
    );
  });
});

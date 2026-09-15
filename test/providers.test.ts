import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completionUrl, HttpCompletionProvider } from '../src/providers';

describe('HTTP provider against a real local server', () => {
  let server: Server;
  let baseUrl: string;
  let status = 200;
  let payload: unknown;
  let observed: { path?: string; auth?: string; body?: any };
  beforeEach(async () => {
    status = 200;
    payload = { choices: [{ text: ' a + b;' }] };
    observed = {};
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      observed = {
        path: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/beta/`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const request = { prefix: 'return', suffix: '\n}', languageId: 'javascript', maxTokens: 128 };
  const context = () => ({ apiKey: 'test-key', signal: new AbortController().signal });
  it('sends DeepSeek FIM prefix, suffix, model and authentication', async () => {
    const provider = new HttpCompletionProvider({
      id: 'deepseek',
      baseUrl,
      model: 'deepseek-flash',
      protocol: 'fim',
    });
    expect(await provider.complete(request, context())).toBe(' a + b;');
    expect(observed.path).toBe('/beta/completions');
    expect(observed.auth).toBe('Bearer test-key');
    expect(observed.body).toMatchObject({
      prompt: 'return',
      suffix: '\n}',
      model: 'deepseek-flash',
      max_tokens: 128,
      stream: false,
    });
    expect(observed.body.messages).toBeUndefined();
  });
  it('supports chat-compatible backends', async () => {
    payload = { choices: [{ message: { content: ' a + b;' } }] };
    const provider = new HttpCompletionProvider({
      id: 'openai-compatible',
      baseUrl,
      model: 'coder',
      protocol: 'chat',
    });
    expect(await provider.complete(request, context())).toBe(' a + b;');
    expect(observed.path).toBe('/beta/chat/completions');
    expect(JSON.parse(observed.body.messages[1].content)).toEqual({
      language: 'javascript',
      prefix: 'return',
      suffix: '\n}',
    });
  });
  it('does not expose server response bodies in errors', async () => {
    status = 401;
    payload = { error: 'secret test-key private code' };
    const provider = new HttpCompletionProvider({
      id: 'deepseek',
      baseUrl,
      model: 'm',
      protocol: 'fim',
    });
    await expect(provider.complete(request, context())).rejects.toThrow('HTTP 401');
    await expect(provider.complete(request, context())).rejects.not.toThrow('test-key');
  });
  it('rejects malformed responses instead of inserting undefined', async () => {
    payload = { choices: [] };
    const provider = new HttpCompletionProvider({
      id: 'deepseek',
      baseUrl,
      model: 'm',
      protocol: 'fim',
    });
    await expect(provider.complete(request, context())).rejects.toThrow('缺少补全文本');
  });
  it('supports request cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new HttpCompletionProvider({
      id: 'deepseek',
      baseUrl,
      model: 'm',
      protocol: 'fim',
    });
    await expect(provider.complete(request, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  it('validates endpoints', () => {
    expect(completionUrl('https://api.deepseek.com/beta/', 'fim')).toBe(
      'https://api.deepseek.com/beta/completions',
    );
    expect(() => completionUrl('file:///a', 'fim')).toThrow();
    expect(() => completionUrl('https://user:key@host', 'fim')).toThrow();
  });
});

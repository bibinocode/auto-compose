import { describe, expect, it } from 'vitest';
import { readSse } from '../src/providers/sse';

describe('SSE 解析器', () => {
  const stream = (text: string, width: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        for (let start = 0; start < bytes.length; start += width)
          controller.enqueue(bytes.slice(start, start + width));
        controller.close();
      },
    });
  it('正确解析拆开 UTF-8 中文和 CRLF 的单字节网络分片', async () => {
    const events = [];
    for await (const data of readSse(
      stream(': keepalive\r\n\r\ndata: {"text":"中文补全"}\r\n\r\ndata: [DONE]\r\n\r\n', 1),
      new AbortController().signal,
    ))
      events.push(data);
    expect(events).toEqual(['{"text":"中文补全"}', '[DONE]']);
  });
  it('兼容多行 data 和没有末尾空行的事件', async () => {
    const events = [];
    for await (const data of readSse(
      stream('data: one\ndata: two\n\ndata: end', 7),
      new AbortController().signal,
    ))
      events.push(data);
    expect(events).toEqual(['one\ntwo', 'end']);
  });
  it('在等待网络数据时取消 reader 并释放锁', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const iterator = readSse(body, controller.signal);
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});

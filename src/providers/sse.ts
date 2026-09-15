import { abortError, CompletionError } from '../core';

/**
 * 按 SSE 事件边界解码。网络 chunk 可能切开中文 UTF-8、CRLF 或一个 JSON 对象，
 * 因此不能直接对每个 chunk 调用 JSON.parse，也不能假定一行就是一次 read。
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw abortError();
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortError();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // 正常补全事件远小于 1MB；限制无换行响应，避免损坏服务持续占用内存。
      if (buffer.length > 1024 * 1024)
        throw new CompletionError('流式事件过大，服务响应不符合 SSE 协议。');
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
      }
      if (done) {
        // 部分兼容服务在最后一个事件后不输出空行，仍允许读取完整 data 行。
        const data = buffer
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

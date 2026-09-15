/** 只携带可安全展示的摘要，禁止放入原始响应、代码或密钥。 */
export class CompletionError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

export function abortError(): Error {
  return new DOMException('Cancelled', 'AbortError');
}

/** 防抖和节流共用的可取消等待，不留下后台计时器。 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 即使第三方 Provider 忽略 signal，调用方也能及时结束等待。 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** 仅驻留内存的 LRU 缓存，避免将私有代码写入磁盘。 */
export class CompletionCache {
  private entries = new Map<string, { value: string; expires: number }>();
  constructor(
    private capacity = 64,
    private ttl = 60000,
  ) {}
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.expires < Date.now()) return;
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: string): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttl });
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void {
    this.entries.clear();
  }
}

/** 仅移除完整 Markdown 包装；不能用 trim() 破坏缩进或末尾换行。 */
export function cleanCompletion(text: string, eol: string): string {
  const fenced = text.match(/^```[\w+-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return (fenced ? fenced[1] : text).replace(/\r\n|\r|\n/g, eol);
}

import { describe, expect, it, vi } from 'vitest';
import { abortable, cleanCompletion, CompletionCache, delay } from '../src/core';

describe('completion lifecycle', () => {
  it('cancels a pending debounce', async () => {
    const controller = new AbortController();
    const result = delay(10000, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('bounds a provider that ignores cancellation', async () => {
    const controller = new AbortController();
    const result = abortable(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('retains indentation and converts EOLs without stripping braces', () => {
    expect(cleanCompletion('```ts\n  return a;\n}\n```', '\r\n')).toBe('  return a;\r\n}');
    expect(cleanCompletion('  foo()\n', '\n')).toBe('  foo()\n');
  });
  it('evicts least recently used cache entries and expires old entries', () => {
    vi.useFakeTimers();
    try {
      const cache = new CompletionCache(2, 100);
      cache.set('a', 'A');
      cache.set('b', 'B');
      expect(cache.get('a')).toBe('A');
      cache.set('c', 'C');
      expect(cache.get('b')).toBeUndefined();
      vi.advanceTimersByTime(101);
      expect(cache.get('a')).toBeUndefined();
      cache.clear();
      expect(cache.get('c')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

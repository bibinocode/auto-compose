import { describe, expect, it } from 'vitest';
import { GhostTextAcceptanceTracker } from '../src/completion/GhostTextAcceptanceTracker';

describe('GhostTextAcceptanceTracker 事件时序', () => {
  it('文档和光标事件先于命令回调时仍识别完整接受', () => {
    const tracker = new GhostTextAcceptanceTracker();
    tracker.expect({
      id: 'a',
      uri: 'file:a',
      version: 1,
      offset: 7,
      replacedText: ';',
      insertText: 'a + b;',
    });
    const text = 'return a + b;';
    expect(
      tracker.onDocumentChange(
        'file:a',
        2,
        [{ rangeOffset: 7, rangeLength: 0, text: 'a + b' }],
        (a, b) => text.slice(a, b),
      )?.kind,
    ).toBe('full');
    expect(tracker.onSelectionChange('file:a', 2, 12)?.id).toBe('a');
    expect(tracker.onSelectionChange('file:a', 2, 12)).toBeUndefined();
  });
  it('原生补全最小化替换范围时仍正确识别', () => {
    const tracker = new GhostTextAcceptanceTracker();
    tracker.expect({
      id: 'b',
      uri: 'file:a',
      version: 1,
      offset: 8,
      replacedText: 'lo',
      insertText: 'log(value)',
    });
    const text = 'console.log(value)';
    expect(
      tracker.onDocumentChange(
        'file:a',
        2,
        [{ rangeOffset: 10, rangeLength: 0, text: 'g(value)' }],
        (a, b) => text.slice(a, b),
      )?.kind,
    ).toBe('full');
    expect(tracker.onSelectionChange('file:a', 2, 18)?.id).toBe('b');
  });
  it('CRLF 多行和部分接受不会中断后续候选链', () => {
    const tracker = new GhostTextAcceptanceTracker();
    tracker.expect({
      id: 'c',
      uri: 'file:a',
      version: 1,
      offset: 0,
      replacedText: '',
      insertText: 'first\r\nsecond',
    });
    expect(
      tracker.onDocumentChange(
        'file:a',
        2,
        [{ rangeOffset: 0, rangeLength: 0, text: 'first\r\n' }],
        (a, b) => 'first\r\n'.slice(a, b),
      )?.kind,
    ).toBe('partial');
    expect(tracker.onSelectionChange('file:a', 2, 7)?.kind).toBe('partial');
    expect(
      tracker.onDocumentChange(
        'file:a',
        3,
        [{ rangeOffset: 7, rangeLength: 0, text: 'second' }],
        (a, b) => 'first\r\nsecond'.slice(a, b),
      )?.kind,
    ).toBe('full');
  });
  it('拒绝相同光标位置但内容不同、旧版本或跨文件的伪接受', () => {
    const tracker = new GhostTextAcceptanceTracker();
    tracker.expect({
      id: 'd',
      uri: 'file:a',
      version: 3,
      offset: 0,
      replacedText: '',
      insertText: 'hello',
    });
    expect(
      tracker.onDocumentChange(
        'file:a',
        4,
        [{ rangeOffset: 0, rangeLength: 0, text: 'other' }],
        () => 'other',
      ),
    ).toBeUndefined();
    expect(tracker.onSelectionChange('file:a', 4, 5)).toBeUndefined();
  });
});

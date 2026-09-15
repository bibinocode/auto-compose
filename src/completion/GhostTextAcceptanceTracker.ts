/** 候选快照使用偏移而非仅使用行号，同时支持行尾替换、CRLF 和部分接受。 */
export interface ExpectedAcceptance {
  id: string;
  uri: string;
  version: number;
  offset: number;
  replacedText: string;
  insertText: string;
}
export interface ObservedChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}
export interface AcceptanceResult {
  id: string;
  kind: 'full' | 'partial';
  endOffset: number;
}

/**
 * 接受命令回调晚于文档/光标事件，不能依赖它判断用户是否接受了灰字。
 * 先匹配实际文本事务，再在光标事件验证终点；命令仅作为确认与计数兜底。
 * 与 Continue 的设计意图一致，但这里额外处理替换范围、部分接受和过期候选。
 */
export class GhostTextAcceptanceTracker {
  private expected?: ExpectedAcceptance & { expires: number };
  private observed?: AcceptanceResult & { uri: string; version: number; expires: number };
  expect(value: ExpectedAcceptance): void {
    this.expected = { ...value, expires: Date.now() + 60000 };
  }
  clear(): void {
    this.expected = undefined;
    this.observed = undefined;
  }

  onDocumentChange(
    uri: string,
    version: number,
    changes: readonly ObservedChange[],
    textAt: (start: number, end: number) => string,
  ): AcceptanceResult | undefined {
    const expected = this.expected;
    if (!expected || expected.uri !== uri) return;
    if (expected.expires < Date.now() || version <= expected.version || changes.length !== 1) {
      this.clear();
      return;
    }
    const change = changes[0];
    // VS Code 有时将整段替换规约为仅插入中间缺失部分，统一还原为替换后的文本。
    let resulting = '';
    const relative = change.rangeOffset - expected.offset;
    if (relative >= 0 && relative + change.rangeLength <= expected.replacedText.length) {
      resulting =
        expected.replacedText.slice(0, relative) +
        change.text +
        expected.replacedText.slice(relative + change.rangeLength);
    }
    const full =
      resulting === expected.insertText &&
      textAt(expected.offset, expected.offset + resulting.length) === resulting;
    const partial =
      !full &&
      change.rangeOffset === expected.offset &&
      change.rangeLength === 0 &&
      change.text.length > 0 &&
      expected.insertText.startsWith(change.text);
    if (!full && !partial) {
      this.clear();
      return;
    }
    const result: AcceptanceResult = {
      id: expected.id,
      kind: full ? 'full' : 'partial',
      endOffset: change.rangeOffset + change.text.length,
    };
    this.observed = { ...result, uri, version, expires: Date.now() + 1000 };
    if (full) this.expected = undefined;
    else
      this.expected = {
        ...expected,
        offset: expected.offset + change.text.length,
        version,
        insertText: expected.insertText.slice(change.text.length),
      };
    return result;
  }

  onSelectionChange(uri: string, version: number, offset: number): AcceptanceResult | undefined {
    const observed = this.observed;
    if (
      observed &&
      observed.uri === uri &&
      observed.version === version &&
      observed.expires >= Date.now() &&
      observed.endOffset === offset
    ) {
      this.observed = undefined;
      return observed;
    }
    this.clear();
    return;
  }
}

import { describe, expect, it } from 'vitest';
import { validatePanelSettings, panelCommands } from '../src/ui/messages';
import { chooseWindow, identifiers } from '../src/context/ranking';

describe('侧边栏消息边界', () => {
  it('接受合法服务配置，拒绝未注册 provider 和未声明设置', () => {
    expect(
      validatePanelSettings({ provider: 'deepseek', maxTokens: 128, streaming: true }, [
        'deepseek',
      ]),
    ).toMatchObject({ maxTokens: 128 });
    expect(() => validatePanelSettings({ provider: 'unknown' }, ['deepseek'])).toThrow();
    expect(() =>
      validatePanelSettings({ apiKey: 'should-not-cross-webview' }, ['deepseek']),
    ).toThrow();
    expect(() => validatePanelSettings({ maxTokens: -1 }, ['deepseek'])).toThrow();
    expect(panelCommands.has('workbench.action.terminal.new')).toBe(false);
  });
  it('自定义服务要求模型和正确的 URL', () => {
    expect(() =>
      validatePanelSettings({ provider: 'openai-compatible', model: '', baseUrl: '' }, [
        'openai-compatible',
      ]),
    ).toThrow();
    expect(() => validatePanelSettings({ baseUrl: 'file:///tmp' }, ['deepseek'])).toThrow();
  });
});

describe('关联片段排序', () => {
  it('定位匹配的标识符并限制发送字符数', () => {
    const content =
      'unrelated line\n'.repeat(30) +
      'function calculateInvoice(customer) { return customer.total; }\n' +
      'other\n'.repeat(30);
    const result = chooseWindow(content, identifiers('calculateInvoice(customer)'), 0, 500);
    expect(result.score).toBeGreaterThan(0);
    expect(result.content).toContain('calculateInvoice');
    expect(result.content.length).toBeLessThanOrEqual(500);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_: string, fallback: unknown) => fallback }) },
}));
import { defaults, readSettings } from '../src/config/settings';
import { secretId } from '../src/config/credentials';

describe('配置契约', () => {
  it('清单与运行时的全部默认值一致', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const [key, value] of Object.entries(defaults))
      expect(
        manifest.contributes.configuration.properties[`autoCompose.${key}`].default,
        key,
      ).toEqual(value);
  });
  it('密钥隔离服务与 Provider，但 URL 末尾斜线保持兼容', () => {
    const settings = readSettings();
    expect(secretId(settings)).toBe(secretId({ ...settings, baseUrl: settings.baseUrl + '/' }));
    expect(secretId(settings)).not.toBe(
      secretId({ ...settings, baseUrl: 'https://different.test' }),
    );
    expect(secretId(settings)).not.toBe(secretId({ ...settings, provider: 'openai-compatible' }));
  });
});

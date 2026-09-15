import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import type { Settings } from './settings';

/** 保留 0.1 版本密钥标识，升级不要求重新输入 Key。 */
export function secretId(settings: Settings): string {
  const endpoint = ['deepseek', 'openai-compatible'].includes(settings.provider)
    ? settings.baseUrl.replace(/\/+$/, '')
    : settings.provider;
  return `autoCompose.key.${settings.provider}.${createHash('sha256').update(endpoint).digest('hex')}`;
}

/** 服务地址参与密钥隔离，防止切换配置后将旧服务密钥发给新服务。 */
export class Credentials {
  constructor(private readonly secrets: vscode.SecretStorage) {}
  get(settings: Settings): Thenable<string | undefined> {
    return this.secrets.get(secretId(settings));
  }
  set(settings: Settings, key: string): Thenable<void> {
    return this.secrets.store(secretId(settings), key.trim());
  }
  delete(settings: Settings): Thenable<void> {
    return this.secrets.delete(secretId(settings));
  }
}

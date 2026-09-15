import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Key 只通过当前进程环境传入；输出和报告都不包含鉴权信息。
const apiKey = process.env.AUTO_COMPOSE_TEST_KEY;
if (!apiKey) throw new Error('请通过 AUTO_COMPOSE_TEST_KEY 环境变量提供测试密钥。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'artifacts'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/providers/http.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(root, 'artifacts/provider-client.cjs'),
});
const { HttpCompletionProvider } = createRequire(import.meta.url)(
  path.join(root, 'artifacts/provider-client.cjs'),
);
const model = process.env.AUTO_COMPOSE_TEST_MODEL || 'deepseek-flash';
const provider = new HttpCompletionProvider({
  id: 'deepseek',
  baseUrl: 'https://api.deepseek.com/beta',
  model,
  protocol: 'fim',
});
const request = {
  prefix: 'function add(a, b) {\n  return ',
  suffix: ';\n}',
  languageId: 'javascript',
  maxTokens: 32,
};
const report = { model, checks: [] };
for (const mode of ['json', 'sse']) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const start = Date.now();
  try {
    let text = '';
    let chunks = 0;
    if (mode === 'json')
      text = await provider.complete(request, { apiKey, signal: controller.signal });
    else
      for await (const chunk of provider.stream(request, { apiKey, signal: controller.signal })) {
        text += chunk;
        chunks++;
      }
    if (!text.trim()) throw new Error('服务返回空补全');
    report.checks.push({
      mode,
      passed: true,
      milliseconds: Date.now() - start,
      characters: text.length,
      ...(chunks ? { chunks } : {}),
    });
  } catch (error) {
    report.checks.push({ mode, passed: false, error: error.message });
    process.exitCode = 1;
    break;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
if (process.exitCode) {
  // 失败时只读取公开模型 ID 来帮助定位，不输出原始错误正文。
  try {
    const response = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) report.availableModels = (await response.json()).data?.map((item) => item.id);
    else report.modelsHttpStatus = response.status;
  } catch {
    report.modelsLookup = 'unavailable';
  }
}
writeFileSync(path.join(root, 'artifacts/live-test-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

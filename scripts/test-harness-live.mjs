import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';

// 只使用公开的 Harness 需求夹具，密钥来自进程环境，不写入报告。
const apiKey = process.env.AUTO_COMPOSE_TEST_KEY;
if (!apiKey) throw new Error('缺少测试环境密钥');
mkdirSync('artifacts', { recursive: true });
await build({
  entryPoints: ['src/providers/http.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'artifacts/harness-provider.cjs',
});
await build({
  entryPoints: ['src/completion/engine.ts', 'src/services/session.ts'],
  outdir: 'artifacts/harness',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
});
const require = createRequire(import.meta.url);
const { CompletionEngine } = require('../artifacts/harness/completion/engine.cjs');
const { Session } = require('../artifacts/harness/services/session.cjs');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const settings = Object.fromEntries(
  Object.entries(manifest.contributes.configuration.properties).map(([key, value]) => [
    key.replace('autoCompose.', ''),
    value.default,
  ]),
);
const { HttpCompletionProvider } = createRequire(import.meta.url)(
  '../artifacts/harness-provider.cjs',
);
const provider = new HttpCompletionProvider({
  id: 'deepseek',
  baseUrl: 'https://api.deepseek.com/beta',
  model: 'deepseek-flash',
  protocol: 'fim',
});
const request = {
  prefix:
    '// TODO: 实现一个人机交互的Harness智能体\n// 该智能体可以接收用户的输入，并输出一个响应\nfunction HarnessAgent() {\n  ',
  suffix: '\n}\n\nmodule.exports = HarnessAgent;',
  languageId: 'javascript',
  maxTokens: 256,
  maxLines: 12,
};
const began = Date.now();
try {
  const reports = [];
  for (const streaming of [false, true]) {
    const session = new Session();
    const { text } = await new CompletionEngine(session).generate({
      request,
      settings: { ...settings, streaming, minRequestIntervalMs: 0 },
      provider,
      apiKey,
      documentId: 'fixture',
      offset: request.prefix.length,
      eol: '\n',
      signal: AbortSignal.timeout(20000),
    });
    const source = request.prefix + text + request.suffix;
    // 执行已知固定需求的生成结果，验证真实输入/返回值，而不是只检查候选非空。
    const probe = `\nconst agent = new module.exports(); const method = Object.keys(agent).find(key => typeof agent[key] === 'function' && agent[key].length > 0); if (!method) throw Error('缺少接收输入的方法'); [agent[method]('first input'), agent[method]('second input')];`;
    const outputs = new Script(source + probe).runInNewContext(
      { module: { exports: {} } },
      { timeout: 200 },
    );
    assert.equal(typeof outputs[0], 'string');
    assert.equal(typeof outputs[1], 'string');
    assert.notEqual(outputs[0], outputs[1]);
    writeFileSync(`artifacts/harness-${streaming ? 'sse' : 'json'}.js`, source);
    reports.push({ streaming, passed: true, usage: session.usage, lines: text.split('\n').length });
    session.dispose();
  }
  const report = { milliseconds: Date.now() - began, reports };
  writeFileSync('artifacts/harness-live-result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(error.message);
  process.exitCode = 1;
}

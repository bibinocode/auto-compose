import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// 固定模拟检索/网络耗时，只测本地调度变化；不请求真实 API，也不代表模型响应速度。
mkdirSync('artifacts', { recursive: true });
await build({
  entryPoints: ['src/completion/engine.ts', 'src/services/session.ts'],
  outdir: 'artifacts/latency-bench',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
});
const require = createRequire(import.meta.url);
const { CompletionEngine } = require('../artifacts/latency-bench/completion/engine.cjs');
const { Session } = require('../artifacts/latency-bench/services/session.cjs');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const settings = Object.fromEntries(
  Object.entries(manifest.contributes.configuration.properties).map(([key, value]) => [
    key.replace('autoCompose.', ''),
    value.default,
  ]),
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const measure = async (fn) => {
  const start = performance.now();
  await fn();
  return +(performance.now() - start).toFixed(2);
};
const old = [],
  current = [],
  cached = [];
for (let i = 0; i < 5; i++) {
  old.push(
    await measure(async () => {
      await wait(300);
      await wait(80);
      await wait(40);
    }),
  );
  const session = new Session();
  const engine = new CompletionEngine(session);
  const input = {
    request: { prefix: 'return ', suffix: ';', languageId: 'typescript', maxTokens: 256 },
    settings: { ...settings, minRequestIntervalMs: 0 },
    provider: {
      id: 'bench',
      displayName: 'bench',
      complete: async () => {
        await wait(40);
        return 'alpha';
      },
    },
    documentId: 'fixture',
    offset: 7,
    eol: '\n',
    signal: new AbortController().signal,
  };
  current.push(
    await measure(async () => {
      const triggered = Date.now();
      await wait(80);
      await engine.generate({ ...input, notBefore: triggered + 150 });
    }),
  );
  cached.push(await measure(() => engine.generate({ ...input, notBefore: Date.now() + 3000 })));
  session.dispose();
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  scenario: 'synthetic: context=80ms, provider=40ms, 5 samples; old scheduling simulated',
  oldMedianMs: median(old),
  newMedianMs: median(current),
  engineCacheMedianMs: median(cached),
};
writeFileSync('artifacts/completion-performance.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

// 合成项目只用于测量本地索引的构建和热查询，不代表真实大型项目的性能保证。
const worker = new Worker(path.resolve('dist/projectWorker.js'));
let sequence = 0;
const waiting = new Map();
worker.on('message', ({ id, result, error }) => {
  const callback = waiting.get(id);
  waiting.delete(id);
  error ? callback.reject(new Error(error)) : callback.resolve(result);
});
const rpc = (method, args) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
try {
  const files = Array.from({ length: 1000 }, (_, i) => ({
    path: `/project/api${i}.ts`,
    version: 1,
    text: `/** 获取账户 ${i} */ export function fetchAccount${i}(id: string) { return {id}; }`,
  }));
  files.push({ path: '/project/use.ts', version: 1, text: 'const value = fetchAcc' });
  const start = performance.now();
  const stats = await rpc('load', { files });
  const buildMs = performance.now() - start;
  const times = [];
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    await rpc('query', { file: '/project/use.ts', prefix: `fetchAccount${i}`, limit: 6 });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const report = {
    files: stats.files,
    symbols: stats.symbols,
    buildMs: Math.round(buildMs),
    queryMedianMs: Number(times[20].toFixed(2)),
    queryP95Ms: Number(times[38].toFixed(2)),
    samples: 40,
  };
  writeFileSync('artifacts/project-performance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await worker.terminate();
}

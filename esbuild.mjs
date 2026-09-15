import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
// 公共接口仅包含类型声明，可直接随安装包提供给 Provider 扩展开发者。
await mkdir('dist', { recursive: true });
await copyFile('src/api.ts', 'dist/api.d.ts');
// 将 TypeScript 解析器放进独立 Worker bundle，主扩展激活无需加载编译器。
const workerOptions = {
  entryPoints: ['src/project/worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/projectWorker.js',
  minify: true,
};
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: false,
};
if (process.argv.includes('--watch')) {
  const contexts = await Promise.all([esbuild.context(options), esbuild.context(workerOptions)]);
  await Promise.all(contexts.map((context) => context.watch()));
} else await Promise.all([esbuild.build(options), esbuild.build(workerOptions)]);

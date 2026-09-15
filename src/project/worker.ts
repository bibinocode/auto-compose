import { parentPort } from 'node:worker_threads';
import { ProjectAnalyzer } from './analyzer';

const analyzer = new ProjectAnalyzer();
/** Worker 内串行处理快照变更，查询不会观察到半次更新。 */
parentPort?.on('message', ({ id, method, args }) => {
  try {
    let result: unknown;
    if (method === 'load') {
      analyzer.load(args.files, args.configs);
      result = analyzer.stats();
    } else if (method === 'query')
      result = analyzer.query(args.file, args.prefix, args.limit, args.currentText);
    else if (method === 'update')
      result = {
        edits: analyzer.update(args.file, args.learn, args.preserve),
        stats: analyzer.stats(),
      };
    else if (method === 'remove') {
      analyzer.remove(args.file);
      result = { edits: analyzer.edits(), stats: analyzer.stats() };
    } else result = analyzer.stats();
    parentPort?.postMessage({ id, result });
  } catch {
    parentPort?.postMessage({ id, error: '项目分析暂不可用，已保留普通补全。' });
  }
});

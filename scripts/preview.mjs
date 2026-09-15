import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 仅供独立验证侧边栏样式和表单消息。模拟宿主不会保存 Key、修改设置或调用 AI 服务。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const settings = Object.fromEntries(
  Object.entries(manifest.contributes.configuration.properties).map(([key, value]) => [
    key.replace('autoCompose.', ''),
    value.default,
  ]),
);
settings.baseUrl = 'https://api.deepseek.com/beta';
settings.model = 'deepseek-flash';
const state = {
  type: 'state',
  revision: 1,
  settings,
  hasKey: false,
  providers: [
    { id: 'deepseek', displayName: 'DeepSeek' },
    { id: 'openai-compatible', displayName: 'OpenAI 兼容接口' },
  ],
  phase: 'ready',
  detail: '等待输入代码',
  paused: false,
  stats: {
    requests: 12,
    candidates: 9,
    accepted: 7,
    acceptedCharacters: 142,
    cacheHits: 4,
    averageLatencyMs: 462,
    lastFirstTokenMs: 185,
    cancelled: 3,
    errors: 0,
  },
};
const bootstrap = `window.__messages=[]; const previewState=${JSON.stringify(state)}; window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:message=>{window.__messages.push(message);if(message.type==='ready')setTimeout(()=>window.postMessage(previewState,'*'),0);if(message.type==='save'){Object.assign(previewState.settings,message.settings);previewState.revision++;window.postMessage({type:'saved'},'*');window.postMessage(previewState,'*');}}});`;
const server = createServer((req, res) => {
  if (req.url === '/') {
    let html = readFileSync(path.join(root, 'media/sidebar.html'), 'utf8')
      .replaceAll('{{nonce}}', 'local-preview')
      .replaceAll('{{cspSource}}', "'self'")
      .replaceAll('{{styleUri}}', '/sidebar.css')
      .replaceAll('{{logoUri}}', '/logo.png')
      .replaceAll('{{scriptUri}}', '/sidebar.js');
    html = html.replace(
      '<script nonce="local-preview"',
      `<script nonce="local-preview">${bootstrap}</script><script nonce="local-preview"`,
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/sidebar.css' || req.url === '/sidebar.js') {
    res.writeHead(200, {
      'Content-Type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript',
    });
    res.end(readFileSync(path.join(root, 'media', req.url.slice(1))));
  } else if (req.url === '/logo.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(readFileSync(path.join(root, 'media/logo.png')));
  } else if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(4318, '127.0.0.1', () =>
  console.log('侧边栏预览（模拟宿主）：http://127.0.0.1:4318'),
);

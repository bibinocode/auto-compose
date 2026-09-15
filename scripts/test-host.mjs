import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 显式传入本机 Code 可执行文件，不安装扩展到用户现有窗口，不改动全局配置。
const executable = process.argv[2];
if (!executable) throw new Error('用法: node scripts/test-host.mjs <Code 可执行文件路径>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(
  root,
  'artifacts',
  process.env.AUTO_COMPOSE_TEST_KEY ? 'host-live-test' : 'host-test',
);
mkdirSync(path.join(directory, 'user', 'User'), { recursive: true });
mkdirSync(path.join(directory, 'extensions'), { recursive: true });
mkdirSync(path.join(directory, 'workspace'), { recursive: true });
writeFileSync(
  path.join(directory, 'workspace', 'api.ts'),
  '/** 获取账户详情 */\nexport function fetchAccount(id: string) { return { id }; }\nexport function send(id: number, label: string) { return label; }\n',
);
writeFileSync(path.join(directory, 'workspace', 'consumer.ts'), 'const account = fetchAcc');
writeFileSync(
  path.join(directory, 'workspace', 'caller.ts'),
  "import { send } from './api';\nsend(1, 'one');\nsend(2, 'two');\n",
);
writeFileSync(
  path.join(directory, 'workspace', 'repeat.ts'),
  'const a = { timeout: 100 };\nconst b = { timeout: 100 };\nconst c = { timeout: 100 };\n',
);
writeFileSync(
  path.join(directory, 'user', 'User', 'settings.json'),
  JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
  }),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  executable,
  [
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'scripts', 'host-test.cjs')}`,
    `--user-data-dir=${path.join(directory, 'user')}`,
    `--extensions-dir=${path.join(directory, 'extensions')}`,
    '--disable-workspace-trust',
    '--disable-extensions',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
    path.join(directory, 'workspace'),
  ],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
const logs = [];
child.stdout.on('data', (data) => {
  logs.push(data.toString());
  process.stdout.write(data);
});
child.stderr.on('data', (data) => {
  logs.push(data.toString());
  process.stderr.write(data);
});
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 60000);
child.on('exit', (code) => {
  clearTimeout(timeout);
  writeFileSync(path.join(root, 'artifacts', 'host-test.log'), logs.join(''));
  process.exitCode = code ?? 1;
});
child.on('error', (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});

import { describe, expect, it } from 'vitest';
import { ProjectAnalyzer } from '../src/project/analyzer';

describe('项目符号检索与局部联动', () => {
  it('签名输入暂时不完整时等待有效代码，再使用修改前的调用证据', () => {
    const project = new ProjectAnalyzer();
    project.load([
      {
        path: '/project/a.ts',
        version: 1,
        text: 'function send(a: number, b: string) {}\nsend(1, "a");',
      },
    ]);
    expect(
      project.update({
        path: '/project/a.ts',
        version: 2,
        text: 'function send(b: string, a:) {}\nsend(1, "a");',
      }),
    ).toHaveLength(0);
    expect(
      project.update({
        path: '/project/a.ts',
        version: 3,
        text: 'function send(b: string, a: number) {}\nsend(1, "a");',
      })[0].after,
    ).toBe('"a", 1');
    project.dispose();
  });
  it('仅重命名形参不会擅自替换调用参数', () => {
    const project = new ProjectAnalyzer();
    project.load([
      {
        path: '/project/a.ts',
        version: 1,
        text: 'function send(id: number) {}\nconst userId = 2; send(1);',
      },
    ]);
    expect(
      project.update({
        path: '/project/a.ts',
        version: 2,
        text: 'function send(userId: number) {}\nconst userId = 2; send(1);',
      }),
    ).toHaveLength(0);
    project.dispose();
  });
  it('导入位置使用最新文本并保留 use client 指令', () => {
    const project = new ProjectAnalyzer();
    project.load([
      { path: '/project/api.ts', version: 1, text: 'export function fetchAccount() {}' },
      { path: '/project/use.ts', version: 1, text: 'const a = fetchAcc' },
    ]);
    const result = project.query(
      '/project/use.ts',
      'fetchAcc',
      6,
      "'use client';\nconst a = fetchAcc",
    );
    expect(result[0].importOffset).toBe("'use client';".length);
    project.dispose();
  });
  it('新增参数不能使用调用之后才初始化的同名变量', () => {
    const project = new ProjectAnalyzer();
    project.load([
      {
        path: '/project/a.ts',
        version: 1,
        text: 'function send(id: number) {}\nsend(1); let token: string = "x";',
      },
    ]);
    expect(
      project.update({
        path: '/project/a.ts',
        version: 2,
        text: 'function send(id: number, token: string) {}\nsend(1); let token: string = "x";',
      }),
    ).toHaveLength(0);
    project.dispose();
  });
  it('无需打开文件即可检索导出函数、注释、签名与导入建议', () => {
    const project = new ProjectAnalyzer();
    project.load([
      {
        path: '/project/api.ts',
        version: 0,
        text: '/** 获取账户详情 */\nexport async function fetchAccount(id: string) { return { id }; }',
      },
      { path: '/project/use.ts', version: 0, text: 'const account = fetchAcc' },
    ]);
    const result = project.query('/project/use.ts', 'const account = fetchAcc');
    expect(result[0].name).toBe('fetchAccount');
    expect(result[0].signature).toContain('id: string');
    expect(result[0].documentation).toContain('账户');
    expect(result[0].importText).toContain("from './api'");
    expect(project.query('/project/use.ts', '// 获取账户详情')[0].name).toBe('fetchAccount');
    project.dispose();
  });
  it('按真实绑定更新跨文件调用参数，不修改其他模块的同名函数', () => {
    const project = new ProjectAnalyzer();
    const old = 'export function send(id: number, label: string) { return label; }';
    project.load([
      { path: '/project/api.ts', version: 1, text: old },
      { path: '/project/other.ts', version: 0, text: old },
      {
        path: '/project/use.ts',
        version: 0,
        text: "import {send} from './api';\nsend(1, 'one');\nsend(2, 'two');",
      },
      {
        path: '/project/independent.ts',
        version: 0,
        text: "import {send} from './other';\nsend(3, 'three');",
      },
    ]);
    const edits = project.update({
      path: '/project/api.ts',
      version: 2,
      text: 'export function send(label: string, id: number) { return label; }',
    });
    expect(edits).toHaveLength(2);
    expect(edits.every((edit) => edit.file === '/project/use.ts')).toBe(true);
    expect(edits[0].after).toBe("'one', 1");
    project.dispose();
  });
  it('新增参数只复用调用处已有同名同类型绑定，缺少值时不猜测', () => {
    const project = new ProjectAnalyzer();
    project.load([
      { path: '/project/api.ts', version: 1, text: 'export function send(id: number) {}' },
      {
        path: '/project/use.ts',
        version: 1,
        text: "import {send} from './api';\nfunction run(token: string) { send(1); }\nfunction other() { send(2); }",
      },
    ]);
    const edits = project.update({
      path: '/project/api.ts',
      version: 2,
      text: 'export function send(id: number, token: string) {}',
    });
    expect(edits).toHaveLength(1);
    expect(edits[0].after).toBe('1, token');
    project.dispose();
  });
  it('拒绝会改变副作用顺序的参数重排或删除', () => {
    const project = new ProjectAnalyzer();
    project.load([
      {
        path: '/project/api.ts',
        version: 1,
        text: 'export function send(a: number, b: number) {}',
      },
      {
        path: '/project/use.ts',
        version: 1,
        text: "import {send} from './api';\ndeclare function next(): number; send(next(), next());",
      },
    ]);
    expect(
      project.update({
        path: '/project/api.ts',
        version: 2,
        text: 'export function send(b: number, a: number) {}',
      }),
    ).toHaveLength(0);
    project.dispose();
  });
  it('同文件重复属性修改只联动同作用域内同一接收对象', () => {
    const project = new ProjectAnalyzer();
    const before =
      'function run(response: any) {\n  const a = response.data;\n  const b = response.data;\n}\nfunction other(response: any) { return response.data; }';
    project.load([{ path: '/project/a.ts', version: 1, text: before }]);
    const edits = project.update({
      path: '/project/a.ts',
      version: 2,
      text: before.replace('const a = response.data', 'const a = response.payload'),
    });
    expect(edits).toHaveLength(1);
    expect(edits[0].before).toBe('data');
    expect(edits[0].after).toBe('payload');
    project.dispose();
  });
  it('同文件相邻配置值可复用修改，接受第一项后剩余建议重定位保留', () => {
    const project = new ProjectAnalyzer();
    const before =
      'const a = { timeout: 100 };\nconst b = { timeout: 100 };\nconst c = { timeout: 100 };';
    project.load([{ path: '/project/a.ts', version: 1, text: before }]);
    const after = before.replace('100', '2000');
    const edits = project.update({ path: '/project/a.ts', version: 2, text: after });
    expect(edits).toHaveLength(2);
    const edit = edits[0];
    const accepted = after.slice(0, edit.start) + edit.after + after.slice(edit.end);
    const remaining = project.update(
      { path: '/project/a.ts', version: 3, text: accepted },
      false,
      true,
    );
    expect(remaining).toHaveLength(1);
    expect(accepted.slice(remaining[0].start, remaining[0].end)).toBe('100');
    project.dispose();
  });
  it('tsconfig 路径别名可定位调用声明', () => {
    const project = new ProjectAnalyzer();
    project.load(
      [
        {
          path: '/project/api.ts',
          version: 1,
          text: 'export function send(a: number, b: string) {}',
        },
        { path: '/project/use.ts', version: 1, text: "import {send} from '@/api'; send(1, 'a');" },
      ],
      [{ root: '/project', options: { baseUrl: '.', paths: { '@/*': ['./*'] } } }],
    );
    expect(
      project.update({
        path: '/project/api.ts',
        version: 2,
        text: 'export function send(b: string, a: number) {}',
      }),
    ).toHaveLength(1);
    project.dispose();
  });
});

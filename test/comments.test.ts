import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { hasNearbyComment, contextComment } from '../src/completion/comments';
import { lineLimit } from '../src/completion/postprocess';
import { CompletionEngine } from '../src/completion/engine';
import { Session } from '../src/services/session';
import { fimPrefix } from '../src/providers/http';
import type { Settings } from '../src/config/settings';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const settings = Object.fromEntries(
  Object.entries(manifest.contributes.configuration.properties).map(([key, value]) => [
    key.replace('autoCompose.', ''),
    (value as { default: unknown }).default,
  ]),
) as unknown as Settings;
const cases = [
  ['python', '# TODO: 计算斐波那契\ndef '],
  ['javascript', '// TODO: 计算斐波那契\nconst fib = '],
  ['typescript', '/** 计算斐波那契 */\nexport const fib = '],
  ['java', '// TODO: 计算斐波那契\npublic static int '],
  ['c', '/* TODO: 计算斐波那契 */\nint '],
  ['cpp', '// 计算斐波那契\nstd::uint64_t '],
  ['csharp', '/// <summary>计算斐波那契</summary>\npublic int '],
  ['go', '// TODO: 计算斐波那契\nfunc '],
  ['rust', '/// TODO: 计算斐波那契\npub fn '],
  ['kotlin', '// FIXME: 实现求和\nfun '],
  ['swift', '// 实现求和\nfunc '],
  ['php', '// TODO: 求和\nfunction '],
  ['ruby', '# TODO: 求和\ndef '],
  ['shellscript', '# TODO: 备份文件\nbackup() '],
  ['sql', '-- TODO: 查询前十名\nSELECT '],
  ['lua', '--[[ TODO: 计算求和 ]]\nlocal function '],
  ['html', '<!-- TODO: 添加登录表单 -->\n<form '],
  ['css', '/* TODO: 居中布局 */\n.container '],
  ['powershell', '<# TODO: 备份文件 #>\nfunction '],
  ['clojure', '; TODO: 求和\n(defn '],
  ['vb', "' TODO: 求和\nPublic Function "],
  ['custom-language', '// TODO: 实现接口\nimplement '],
];

describe('跨语言注释驱动补全', () => {
  it.each(cases)('%s 注释和半行声明支持多行，JSON/SSE 不截为单行', async (languageId, prefix) => {
    expect(hasNearbyComment(prefix, languageId)).toBe(true);
    expect(lineLimit(prefix, settings, languageId)).toBe(12);
    const request = { prefix, suffix: '\n', languageId, maxTokens: 256 };
    expect(fimPrefix(request).endsWith(prefix)).toBe(true);
    for (const streaming of [false, true]) {
      const session = new Session();
      const code = 'first line\n    second line'; // 验证管线保留，不将夹具误称为真实模型生成。
      const complete = vi.fn(async () => code);
      const provider = {
        id: 'test',
        displayName: 'test',
        complete,
        async *stream() {
          yield 'first line\n';
          yield '    second line';
        },
      };
      const result = await new CompletionEngine(session).generate({
        request,
        settings: { ...settings, streaming, minRequestIntervalMs: 0 },
        provider,
        documentId: 'fixture',
        offset: prefix.length,
        eol: '\n',
        signal: new AbortController().signal,
      });
      expect(result.text).toBe(code);
      if (!streaming) expect(complete).toHaveBeenCalledWith(request, expect.anything());
      session.dispose();
    }
  });
  it('支持多行文档注释、CRLF、空行和无 TODO 的中文需求', () => {
    for (const prefix of [
      '/**\n * 计算总价\n */\n\nconst price = ',
      '// 计算总价\r\nconst price = ',
      '/*\n * TODO: 继续实现',
    ])
      expect(hasNearbyComment(prefix, 'typescript')).toBe(true);
  });
  it('不将字符串、远处 TODO 或跨代码注释用于当前多行决策，尊重单行设置', () => {
    for (const prefix of [
      'const text = "// TODO: sum";\nconst n = ',
      '// TODO: sum\nconst done = 1;\nconst n = ',
      '// TODO: sum\n\n\n\nconst n = ',
    ])
      expect(lineLimit(prefix, settings, 'typescript')).toBe(1);
    expect(lineLimit(cases[1][1], { ...settings, multiline: 'never' }, 'javascript')).toBe(1);
    expect(lineLimit('-- decrement\nvalue', settings, 'python')).toBe(1);
  });
  it('关联片段使用目标语言注释包装，不能提前闭合块注释', () => {
    expect(contextComment('x', 'sql')).toBe('-- x');
    expect(contextComment('x', 'clojure')).toBe('; x');
    expect(contextComment('x */ y', 'css')).toBe('/* x   y */');
    expect(contextComment('x --> y', 'html')).toBe('<!-- x   y -->');
    expect(
      fimPrefix({
        prefix: '<div ',
        suffix: '',
        languageId: 'html',
        maxTokens: 32,
        context: [{ filepath: 'view.html', content: '<span/>', source: 'recent' }],
      }),
    ).toContain('<!-- <span/> -->');
  });
});

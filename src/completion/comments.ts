/**
 * 注释语法仅用于决定生成长度与包装关联片段，不限制哪些语言可以请求补全。
 * 未列出的语言仍保留全部原始前后文，并使用常见注释语法作为启发式回退。
 */
interface CommentSyntax {
  line: string[];
  blocks: [string, string][];
}
const common: CommentSyntax = {
  line: ['//', '#', '--'],
  blocks: [
    ['/*', '*/'],
    ['<!--', '-->'],
  ],
};
export function commentSyntax(language: string): CommentSyntax {
  if (/^(python|ruby|shellscript|yaml|r|perl|dockerfile|makefile)$/.test(language))
    return {
      line: ['#'],
      blocks:
        language === 'python'
          ? [
              ['"""', '"""'],
              ["'''", "'''"],
            ]
          : [],
    };
  if (/^(sql|lua|haskell)$/.test(language))
    return {
      line: ['--'],
      blocks:
        language === 'lua'
          ? [['--[[', ']]']]
          : language === 'haskell'
            ? [['{-', '-}']]
            : [['/*', '*/']],
    };
  if (/^(html|xml|vue|svelte|markdown)$/.test(language)) return common;
  if (/^(css|scss|less)$/.test(language))
    return { line: language === 'css' ? [] : ['//'], blocks: [['/*', '*/']] };
  if (/^(lisp|clojure|scheme|racket)$/.test(language))
    return { line: [';'], blocks: [['#|', '|#']] };
  if (/^(vb|vbnet)$/.test(language)) return { line: ["'", 'REM '], blocks: [] };
  if (/^(bat)$/.test(language)) return { line: ['REM ', '::'], blocks: [] };
  if (/^(powershell)$/.test(language)) return { line: ['#'], blocks: [['<#', '#>']] };
  return common;
}

/**
 * 只观察当前半行与紧邻注释块（最多 12 行、4096 字符），不扫描整个文件。
 * TODO、FIXME、中文需求和普通说明一视同仁，不依赖某个关键词或函数名。
 * 中间出现其他代码即停止，避免很早的 TODO 让所有表达式都变成多行。
 */
export function hasNearbyComment(prefix: string, language = ''): boolean {
  const lines = prefix.slice(-4096).split(/\r?\n/).slice(-12);
  const syntax = commentSyntax(language);
  const current = lines.at(-1)?.trimStart() ?? '';
  const lineComment = (line: string) =>
    syntax.line.some((marker) => line.toLowerCase().startsWith(marker.toLowerCase()));
  if (lineComment(current) || syntax.blocks.some(([start]) => current.startsWith(start)))
    return true;
  let index = lines.length - 2;
  let blanks = 0;
  while (index >= 0 && !lines[index].trim()) {
    if (++blanks > 2) return false;
    index--;
  }
  if (index < 0) return false;
  const previous = lines[index].trim();
  for (const [open, close] of syntax.blocks) {
    // 仅完整且独占的注释块为其后的代码提供多行意图；块内续写也可识别。
    if (previous.endsWith(close)) {
      for (let start = index; start >= 0; start--) {
        if (lines[start].trimStart().startsWith(open)) return true;
      }
    }
  }
  if (lineComment(previous)) return true;
  // 支持尚未关闭的文档注释；已关闭块后出现代码时不能继续沿用。
  for (const [open, close] of syntax.blocks) {
    const before = lines.slice(0, index + 1).join('\n');
    const opening = before.lastIndexOf(open);
    if (
      open !== close &&
      opening >= 0 &&
      before.indexOf(close, opening + open.length) < 0 &&
      before.slice(0, opening).split('\n').at(-1)?.trim() === ''
    )
      return true;
  }
  return false;
}

/** 关联片段逐行包装，避免 HTML/CSS 等文件被注入不适用的 // 注释。 */
export function contextComment(text: string, language: string): string {
  const syntax = commentSyntax(language);
  const block = /^(html|xml|vue|svelte|markdown)$/.test(language)
    ? ['<!--', '-->']
    : syntax.line.length
      ? undefined
      : syntax.blocks[0];
  return text
    .split(/\r?\n/)
    .map((line) =>
      block
        ? `${block[0]} ${line.replaceAll(block[1], ' ').replaceAll('--', '—')} ${block[1]}`
        : `${syntax.line[0] ?? '//'} ${line}`,
    )
    .join('\n');
}

import { commentSyntax } from './comments';

/**
 * 提取当前编辑附近的需求注释，区别于“看见注释就放开行数”。
 * 只处理独占行的注释，最多回看 40 行/6000 字符；不改写用户代码。
 * 这是有界意图提示，不承诺等价于完整语义分析或自动证明需求满足。
 */
export function implementationIntent(prefix: string, languageId: string): string | undefined {
  const lines = prefix.slice(-6000).split(/\r?\n/).slice(-40);
  const syntax = commentSyntax(languageId);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    const isComment =
      syntax.line.some((marker) => line.startsWith(marker)) ||
      syntax.blocks.some(([open]) => line.startsWith(open)) ||
      line.startsWith('*');
    if (!isComment || !/\b(?:TODO|FIXME|implement|create|build|write)\b|实现|编写|创建/i.test(line))
      continue;
    // 遇到独占的闭合块边界就保守停止借用旧需求，不猜测完整作用域树。
    if (lines.slice(index + 1).some((text) => /^\s*}\s*;?\s*$/.test(text))) return;
    const comments = [line];
    for (let next = index + 1; next < lines.length; next++) {
      const text = lines[next].trim();
      if (syntax.line.some((marker) => text.startsWith(marker)) || /^[*]/.test(text))
        comments.push(text);
      else break;
    }
    return comments.join('\n').slice(0, 1600);
  }
}

/** 只拒绝证据充分的退化输出；正常代码不做猜测性重写。 */
export function qualityIssue(text: string, prefix: string, languageId: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // 未包裹全文的代码围栏表示模型混入解释或另一段代码，不能直接插入源码。
  if (lines.some((line) => /^```/.test(line))) return '候选混入 Markdown 代码块';
  for (let size = 2; size <= 8; size++) {
    for (let start = 0; start + size * 2 <= lines.length; start++) {
      const block = lines.slice(start, start + size);
      if (block.filter((line) => /[\w\u4e00-\u9fff]/.test(line)).length < 2) continue;
      if (block.every((line, index) => line === lines[start + size + index]))
        return '候选出现连续重复代码';
    }
  }
  const intent = implementationIntent(prefix, languageId);
  if (intent && !/package|manifest|metadata|元数据|软件包|包配置|项目配置/i.test(intent)) {
    // 无关包描述字段成批出现才拦截，单独的 name/version 等合理状态不受影响。
    const fields = new Set(
      [
        ...text.matchAll(
          /\b(?:this|self)\.(author|license|homepage|repository|bugs|keywords|dependencies|devDependencies|scripts|engines|publishConfig|peerDependencies|bundledDependencies|packageManager)\s*=/g,
        ),
      ].map((match) => match[1]),
    );
    if (fields.size >= 4) return '候选偏离需求，批量生成包元数据';
  }
}

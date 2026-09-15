/** 轻量标识符相关性排序；不依赖语言解析器，也不将整仓库建立索引。 */
export function identifiers(text: string): Set<string> {
  return new Set(
    (text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).filter(
      (token) =>
        ![
          'const',
          'return',
          'function',
          'class',
          'import',
          'from',
          'this',
          'true',
          'false',
          'null',
          'undefined',
          'export',
          'string',
          'number',
        ].includes(token),
    ),
  );
}

/** 按光标附近标识符选取片段中心，完全无关联时使用最近编辑位置。 */
export function chooseWindow(
  content: string,
  query: Set<string>,
  fallbackLine: number,
  maxChars: number,
): { content: string; score: number } {
  const lines = content.split(/\r?\n/);
  let bestLine = Math.min(fallbackLine, Math.max(0, lines.length - 1));
  let score = 0;
  for (let index = 0; index < lines.length; index++) {
    const matches = [...identifiers(lines[index])].filter((token) => query.has(token)).length;
    if (matches > score) {
      score = matches;
      bestLine = index;
    }
  }
  return {
    content: lines
      .slice(Math.max(0, bestLine - 8), bestLine + 20)
      .join('\n')
      .slice(0, maxChars),
    score,
  };
}

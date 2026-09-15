import { cleanCompletion } from '../core';
import type { Settings } from '../config/settings';
import { hasNearbyComment } from './comments';
import { qualityIssue } from './intent';

/** 自动模式：块开头/空行生成多行，表达式内部优先单行，降低过度补全。 */
export function lineLimit(prefix: string, settings: Settings, languageId = ''): number {
  if (settings.multiline === 'always') return settings.maxLines;
  if (settings.multiline === 'never') return 1;
  const line = prefix.split('\n').at(-1) ?? '';
  // 声明尚未输入完整时也要允许函数体，不能把 def 空格误判成单行表达式。
  const declaration =
    /^\s*(?:(?:async|export|default|pub|public|private|protected|static|internal|override|suspend)\s+)*(?:def|function|class|func|fn|fun|sub|procedure)\s+[^\n]*$/i.test(
      line,
    );
  return hasNearbyComment(prefix, languageId) ||
    declaration ||
    !line.trim() ||
    /[{:][\t ]*$/.test(line)
    ? settings.maxLines
    : 1;
}

/** 只保留已完整接收的行，达到预算时可提前结束 SSE 连接。 */
export function truncateLines(text: string, maxLines: number): { text: string; complete: boolean } {
  const normalized = text.replace(/\r\n/g, '\n');
  let count = 0;
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] === '\n' && ++count >= maxLines)
      return { text: normalized.slice(0, index), complete: true };
  }
  return { text: normalized, complete: false };
}

/**
 * 保守后处理：不以正则推断语法树，不猜测缺失括号。
 * 删除完全重复的后缀时要求至少一个词或一整行，单个闭括号留给行内适配层处理。
 */
export function postprocess(
  raw: string,
  prefix: string,
  suffix: string,
  eol: string,
  maxLines: number,
  languageId = '',
): string {
  let text = cleanCompletion(raw, '\n');
  if (/^```[\w+-]*\n/.test(text)) text = text.replace(/^```[\w+-]*\n/, '').replace(/\n```\s*$/, '');
  if (qualityIssue(text, prefix, languageId)) return '';
  // Chat 服务有时原样复述当前半行；只消除足够长的完整前缀，不删除单个变量名。
  const currentLine = prefix.split(/\r?\n/).at(-1) ?? '';
  if (currentLine.trim().length >= 8 && text.startsWith(currentLine))
    text = text.slice(currentLine.length);
  const normalizedSuffix = suffix.replace(/\r\n/g, '\n');
  for (let size = Math.min(text.length, normalizedSuffix.length, 4000); size >= 4; size--) {
    const overlap = normalizedSuffix.slice(0, size);
    if (overlap.trim().length >= 3 && text.endsWith(overlap)) {
      text = text.slice(0, -size);
      break;
    }
  }
  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length >= 6 && new Set(lines.map((line) => line.trim())).size <= 2) return '';
  text = truncateLines(text, maxLines).text;
  return text.trim() ? text.replace(/\n/g, eol) : '';
}

/** 若模型已输出自动闭合的行尾标点，复用现有尾部，避免出现 foo())。 */
export function mergeLineTail(completion: string, tail: string): string {
  if (tail && /^[\s\])};,]+$/.test(tail) && completion.endsWith(tail)) return completion;
  return completion + tail;
}

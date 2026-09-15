/** 候选复用快照只驻留内存。offset 限制只允许向前输入，退格或中间改写必须重新请求。 */
export interface ReuseInput {
  scope: string;
  prefix: string;
  suffix: string;
  offset: number;
  prefixChars: number;
}
export class CompletionReuse {
  private previous?: ReuseInput & { completion: string; expires: number };
  set(input: ReuseInput, completion: string): void {
    this.previous = { ...input, completion, expires: Date.now() + 60000 };
  }
  get(input: ReuseInput): string | undefined {
    const previous = this.previous;
    if (
      !previous ||
      previous.expires < Date.now() ||
      previous.scope !== input.scope ||
      previous.suffix !== input.suffix
    )
      return;
    const consumed = input.offset - previous.offset;
    if (consumed < 0 || consumed >= previous.completion.length) return;
    const expected = (previous.prefix + previous.completion.slice(0, consumed)).slice(
      -input.prefixChars,
    );
    if (expected !== input.prefix) return;
    return previous.completion.slice(consumed);
  }
  clear(): void {
    this.previous = undefined;
  }
}

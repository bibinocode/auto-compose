import type { TokenUsage } from '../api';

export type Phase =
  | 'ready'
  | 'debouncing'
  | 'context'
  | 'loading'
  | 'paused'
  | 'disabled'
  | 'key'
  | 'error'
  | 'cooldown';
export interface SessionStats {
  requests: number;
  candidates: number;
  accepted: number;
  acceptedCharacters: number;
  cacheHits: number;
  errors: number;
  cancelled: number;
  rejected: number;
  averageLatencyMs: number;
  lastLatencyMs: number;
  lastFirstTokenMs: number;
  lastContextMs: number;
  lastWaitMs: number;
  lastReadyMs: number;
}

/** 本地会话观测，仅记录计数与耗时，不保留源码、Key 或请求正文。 */
export class Session {
  /** 仅持久化累计数字，不保存源码、密钥或请求正文。 */
  readonly usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, unknownRequests: 0 };
  balance = '尚未查询';
  lastSource: 'network' | 'cache' | 'reuse' | '' = '';
  constructor(
    saved?: Partial<Session['usage']>,
    private readonly saveUsage?: (usage: Session['usage']) => void,
  ) {
    for (const key of Object.keys(this.usage) as (keyof Session['usage'])[]) {
      const value = saved?.[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        this.usage[key] = value;
    }
  }
  /** 每次真实请求独立记账，累计快照去重；缓存命中不新建记账器。 */
  beginUsage(): { report: (usage: TokenUsage) => void; finish: () => void } {
    let latest: TokenUsage | undefined;
    let finished = false;
    return {
      report: (usage) => {
        if (
          !finished &&
          [usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          )
        )
          latest = { ...usage };
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (latest) {
          this.usage.promptTokens += latest.promptTokens;
          this.usage.completionTokens += latest.completionTokens;
          this.usage.totalTokens += latest.totalTokens;
        } else this.usage.unknownRequests++;
        this.saveUsage?.({ ...this.usage });
        this.changed();
      },
    };
  }
  phase: Phase = 'ready';
  detail = '等待输入代码';
  pausedUntil = 0;
  readonly stats: SessionStats = {
    requests: 0,
    candidates: 0,
    accepted: 0,
    acceptedCharacters: 0,
    cacheHits: 0,
    errors: 0,
    cancelled: 0,
    rejected: 0,
    averageLatencyMs: 0,
    lastLatencyMs: 0,
    lastFirstTokenMs: 0,
    lastContextMs: 0,
    lastWaitMs: 0,
    lastReadyMs: 0,
  };
  private readonly listeners = new Set<() => void>();
  private readonly offered = new Map<string, number>();
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private totalLatency = 0;
  private completed = 0;
  private disposed = false;
  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
  changed(): void {
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
  set(phase: Phase, detail: string): void {
    this.phase = phase;
    this.detail = detail;
    this.changed();
  }
  isPaused(): boolean {
    return this.pausedUntil > Date.now();
  }
  pause(minutes: number): void {
    clearTimeout(this.pauseTimer);
    this.pausedUntil = Date.now() + minutes * 60000;
    this.set('paused', `暂停至 ${new Date(this.pausedUntil).toLocaleTimeString()}`);
    this.pauseTimer = setTimeout(() => this.resume(), minutes * 60000);
  }
  resume(): void {
    clearTimeout(this.pauseTimer);
    this.pausedUntil = 0;
    this.set('ready', '已恢复补全');
  }
  generated(latency: number, firstToken: number): void {
    this.totalLatency += latency;
    this.completed++;
    this.stats.lastLatencyMs = latency;
    this.stats.lastFirstTokenMs = firstToken;
    this.stats.averageLatencyMs = Math.round(this.totalLatency / this.completed);
    this.changed();
  }
  offer(id: string, characters: number): void {
    this.stats.candidates++;
    this.offered.set(id, characters);
    if (this.offered.size > 100) this.offered.delete(this.offered.keys().next().value!);
    this.changed();
  }
  accept(id: string): void {
    const characters = this.offered.get(id);
    if (characters === undefined) return;
    this.offered.delete(id);
    this.stats.accepted++;
    this.stats.acceptedCharacters += characters;
    this.changed();
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.pauseTimer);
    this.listeners.clear();
    this.offered.clear();
  }
}

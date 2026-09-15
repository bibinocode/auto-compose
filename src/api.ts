/** 服务实际返回的用量，不以字符数估算 token。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
export interface AccountBalance {
  currency: string;
  total: string;
}

/** 可选关联片段，路径仅为工作区相对路径。 */
export interface ContextSnippet {
  filepath: string;
  content: string;
  source: 'recent' | 'definition' | 'project';
}

/** Provider 输入：前后文各自有长度预算，关联片段在 context 中独立传递。 */
export interface CompletionRequest {
  prefix: string;
  suffix: string;
  languageId: string;
  maxTokens: number;
  /** 指令补全的插入行数预算；缺省时 Provider 采用保守短实现。 */
  maxLines?: number;
  context?: ContextSnippet[];
}

/** signal 同时涵盖编辑器取消、配置失效及请求超时。 */
export interface ProviderContext {
  apiKey?: string;
  signal: AbortSignal;
  /** 可选累计用量快照回调，保持旧 Provider 兼容。 */
  onUsage?(usage: TokenUsage): void;
}

/** 外部扩展注册接口；返回仅需插入的代码，不能重复 prefix 或 suffix。 */
export interface CompletionProvider {
  readonly id: string;
  readonly displayName: string;
  /** 本地无鉴权服务可设为 false；默认要求 API Key。 */
  readonly requiresApiKey?: boolean;
  /** 可选账户余额查询。 */
  getBalance?(context: ProviderContext): Promise<AccountBalance[]>;
  /** 必须保留代码缩进，并响应取消信号。 */
  complete(request: CompletionRequest, context: ProviderContext): Promise<string>;
  /** 可选增量接口；每次 yield 新增文本，不能 yield 累计文本。 */
  stream?(request: CompletionRequest, context: ProviderContext): AsyncIterable<string>;
}

/** v1 保持兼容：stream/context 均为可选字段。 */
export interface AutoComposeApi {
  readonly version: 1;
  /** 本地索引状态，供集成方判断冷启动是否完成；不包含源码。 */
  getProjectStatus?(): { files: number; symbols: number; ready: boolean };
  registerProvider(provider: CompletionProvider): { dispose(): void };
}

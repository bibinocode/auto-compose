/** Worker 与扩展宿主只交换数据，TypeScript AST 和类型检查器留在后台线程。 */
export interface IndexedFile {
  path: string;
  text: string;
  version: number;
}
export interface ProjectSymbol {
  name: string;
  file: string;
  signature: string;
  documentation: string;
  kind: 'function' | 'class' | 'interface' | 'variable';
  exported: boolean;
  defaultExport: boolean;
  start: number;
}
export interface SymbolMatch extends ProjectSymbol {
  score: number;
  importText?: string;
  importOffset?: number;
}
export interface LinkedEdit {
  id: string;
  file: string;
  version: number;
  start: number;
  end: number;
  before: string;
  after: string;
  kind: 'signature' | 'repeat';
  reason: string;
  sourceFile: string;
}
export interface ProjectConfig {
  root: string;
  options?: Record<string, unknown>;
}
export interface IndexStats {
  files: number;
  symbols: number;
  ready: boolean;
}

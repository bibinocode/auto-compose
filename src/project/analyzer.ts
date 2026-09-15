import ts from 'typescript';
import path from 'node:path';
import type { IndexedFile, ProjectConfig, ProjectSymbol, SymbolMatch, LinkedEdit } from './types';
import { withinRoot } from './paths';

const normalize = (value: string) =>
  value
    .replace(/\\/g, '/')
    .replace(/^\/([A-Z]):/, (_, drive: string) => `/${drive.toLowerCase()}:`);
const scriptFile = /\.[cm]?[jt]sx?$/i;
const positionKey = (file: string, start: number) => `${file}:${start}`;

/**
 * 基于 TypeScript 语义绑定的本地索引。所有解析、符号解析及引用分析在 Worker 中运行。
 * 虚拟文件系统只包含经过宿主过滤的项目文件，不访问 node_modules 或外部磁盘。
 */
export class ProjectAnalyzer {
  private readonly files = new Map<string, IndexedFile>();
  private symbols: ProjectSymbol[] = [];
  private readonly service: ts.LanguageService;
  private configs: ProjectConfig[] = [];
  private generation = 0;
  private proposals: LinkedEdit[] = [];
  private readonly incomplete = new Map<
    string,
    { program: ts.Program; source: ts.SourceFile; file: IndexedFile }
  >();
  private readonly options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.Preserve,
  };

  constructor() {
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => [...this.files.keys()],
      getScriptVersion: (name) => String(this.files.get(normalize(name))?.version ?? 0),
      getScriptSnapshot: (name) => {
        const file = this.files.get(normalize(name));
        return file ? ts.ScriptSnapshot.fromString(file.text) : undefined;
      },
      getCurrentDirectory: () => '/',
      getDefaultLibFileName: () => '',
      fileExists: (name) => this.files.has(normalize(name)),
      readFile: (name) => this.files.get(normalize(name))?.text,
      directoryExists: (name) =>
        [...this.files.keys()].some((file) =>
          file.startsWith(normalize(name).replace(/\/$/, '') + '/'),
        ),
      getProjectVersion: () => String(this.generation),
      resolveModuleNames: (names, containingFile) =>
        names.map((name) => {
          const config = this.configs
            .filter((entry) => withinRoot(containingFile, entry.root))
            .sort((a, b) => b.root.length - a.root.length)[0];
          const configured = config
            ? ts.convertCompilerOptionsFromJson(config.options ?? {}, config.root).options
            : {};
          return ts.resolveModuleName(
            name,
            containingFile,
            { ...this.options, ...configured },
            host,
          ).resolvedModule;
        }),
    };
    this.service = ts.createLanguageService(host);
  }

  load(files: IndexedFile[], configs: ProjectConfig[] = []): void {
    this.incomplete.clear();
    this.files.clear();
    this.configs = configs.map((config) => ({
      ...config,
      root: normalize(config.root),
      options:
        typeof config.options?.__raw === 'string'
          ? (ts.parseConfigFileTextToJson('tsconfig.json', config.options.__raw).config
              ?.compilerOptions ?? {})
          : config.options,
    }));
    this.proposals = [];
    for (const file of files)
      if (scriptFile.test(file.path))
        this.files.set(normalize(file.path), { ...file, path: normalize(file.path) });
    this.generation++;
    this.rebuildSymbols();
  }
  stats() {
    return { files: this.files.size, symbols: this.symbols.length, ready: true };
  }
  remove(file: string): void {
    this.files.delete(file);
    this.proposals = this.proposals.filter(
      (edit) => edit.file !== file && edit.sourceFile !== file,
    );
    this.generation++;
    this.rebuildSymbols();
  }
  dispose(): void {
    this.service.dispose();
    this.files.clear();
  }

  private rebuildSymbols(): void {
    const program = this.service.getProgram();
    const checker = program?.getTypeChecker();
    this.symbols = [];
    if (!program || !checker) return;
    for (const file of this.files.values()) {
      const source = program.getSourceFile(file.path);
      if (!source) continue;
      const module = checker.getSymbolAtLocation(source);
      if (!module) continue;
      for (const exported of checker.getExportsOfModule(module)) {
        const target =
          exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const declaration = target.valueDeclaration ?? target.declarations?.[0];
        if (!declaration || !this.files.has(declaration.getSourceFile().fileName)) continue;
        const name = exported.name === 'default' ? target.name : exported.name;
        if (!name || name === 'default' || name.startsWith('__')) continue;
        const kind =
          ts.isFunctionDeclaration(declaration) ||
          (ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer)))
            ? 'function'
            : ts.isClassDeclaration(declaration)
              ? 'class'
              : ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
                ? 'interface'
                : 'variable';
        const type = checker.getTypeOfSymbolAtLocation(target, declaration);
        const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
        const signature = signatures.length
          ? `${name}${checker.signatureToString(signatures[0], declaration, ts.TypeFormatFlags.NoTruncation)}`
          : declaration.getText().slice(0, 1000);
        this.symbols.push({
          name,
          file: source.fileName,
          start: declaration.getStart(),
          signature: signature.slice(0, 1400),
          documentation: ts
            .displayPartsToString(target.getDocumentationComment(checker))
            .slice(0, 800),
          kind,
          exported: true,
          defaultExport: exported.name === 'default',
        });
      }
    }
  }

  /** 热路径只遍历紧凑符号元数据，不做全量 AST 遍历，也不等待模型。 */
  query(file: string, prefix: string, limit = 8, currentText?: string): SymbolMatch[] {
    const words = prefix.slice(-1500).match(/[A-Za-z_$][\w$]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [];
    const tail = prefix.match(/[A-Za-z_$][\w$]*$/)?.[0].toLowerCase() ?? '';
    const stop = new Set([
      'const',
      'function',
      'return',
      'await',
      'async',
      'import',
      'from',
      'export',
      'string',
      'number',
    ]);
    const tokens = [
      ...new Set(words.map((word) => word.toLowerCase()).filter((word) => !stop.has(word))),
    ].slice(-24);
    const source =
      currentText !== undefined
        ? ts.createSourceFile(file, currentText, ts.ScriptTarget.Latest, true)
        : this.service.getProgram()?.getSourceFile(file);
    const results: SymbolMatch[] = [];
    for (const symbol of this.symbols) {
      if (symbol.file === file) continue;
      const name = symbol.name.toLowerCase();
      const searchable =
        `${symbol.name} ${symbol.signature} ${symbol.documentation} ${symbol.file}`.toLowerCase();
      let score = tail && name.startsWith(tail) ? 100 : 0;
      for (const token of tokens)
        if (searchable.includes(token))
          score += name === token ? 30 : name.includes(token) ? 15 : 3;
      if (!score) continue;
      results.push({ ...symbol, score });
    }
    return results
      .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
      .slice(0, limit)
      .map((symbol) => ({ ...symbol, ...(source ? this.importFor(symbol, source) : {}) }));
  }

  private importFor(
    symbol: ProjectSymbol,
    source: ts.SourceFile,
  ): { importText?: string; importOffset?: number } {
    // 已声明同名绑定时不添加导入；避免覆盖已有局部变量或重复 import。
    let collision = false;
    const check = (node: ts.Node) => {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isImportSpecifier(node) ||
          ts.isImportClause(node)) &&
        node.name?.getText(source) === symbol.name
      )
        collision = true;
      if (!collision) ts.forEachChild(node, check);
    };
    check(source);
    if (collision) return {};
    let specifier = path.posix
      .relative(path.posix.dirname(source.fileName), symbol.file)
      .replace(/\.[cm]?[jt]sx?$/, '')
      .replace(/\/index$/, '');
    if (!specifier.startsWith('.')) specifier = './' + specifier;
    if (
      source.statements.some(
        (node) => ts.isImportDeclaration(node) && /\.js['"]$/.test(node.moduleSpecifier.getText()),
      )
    )
      specifier += '.js';
    const eol = source.text.includes('\r\n') ? '\r\n' : '\n';
    const imports = source.statements.filter(ts.isImportDeclaration);
    const directives = source.statements.filter(
      (node) => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression),
    );
    const offset = imports.length
      ? imports.at(-1)!.end
      : directives.length
        ? directives[0].end
        : source.text.startsWith('#!')
          ? source.text.indexOf('\n') + 1
          : 0;
    const binding = symbol.defaultExport ? symbol.name : `{ ${symbol.name} }`;
    return {
      importOffset: offset,
      importText: `${offset && source.text[offset - 1] !== '\n' ? eol : ''}import ${symbol.kind === 'interface' ? 'type ' : ''}${binding} from '${specifier}';${eol}`,
    };
  }

  /** 文档变化合并后更新，签名建议依据变更前的真实调用绑定，而不是函数名字符串匹配。 */
  update(file: IndexedFile, learn = true, preserve = false): LinkedEdit[] {
    const baseline = this.incomplete.get(file.path);
    const previous = baseline?.file ?? this.files.get(file.path);
    const oldProgram = baseline?.program ?? this.service.getProgram();
    const oldSource = baseline?.source ?? oldProgram?.getSourceFile(file.path);
    const parsed = ts.createSourceFile(
      file.path,
      file.text,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const valid = !(parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics.length;
    if (!valid && previous && oldProgram && oldSource && !baseline)
      this.incomplete.set(file.path, { file: previous, program: oldProgram, source: oldSource });
    if (this.incomplete.size > 4) this.incomplete.delete(this.incomplete.keys().next().value!);
    if (valid) this.incomplete.delete(file.path);
    const beforeProposals =
      previous && oldProgram && oldSource && learn && valid
        ? this.planSignatures(oldProgram, oldSource, parsed, previous, file)
        : [];
    const repeats =
      previous && oldProgram && oldSource && learn && valid
        ? this.planRepeats(oldProgram, oldSource, parsed, previous, file)
        : [];
    this.files.set(file.path, file);
    this.generation++;
    const span = previous ? this.changeSpan(previous.text, file.text) : undefined;
    this.proposals = this.proposals
      .flatMap((edit) => {
        if (edit.file !== file.path)
          return edit.sourceFile === file.path && !preserve ? [] : [edit];
        if (!preserve || !span) return [];
        if (edit.start >= span.oldEnd)
          return [
            {
              ...edit,
              start: edit.start + span.delta,
              end: edit.end + span.delta,
              version: file.version,
            },
          ];
        return edit.end <= span.start ? [{ ...edit, version: file.version }] : [];
      })
      .filter(
        (edit) => this.files.get(edit.file)?.text.slice(edit.start, edit.end) === edit.before,
      );
    this.rebuildSymbols();
    for (const edit of [...beforeProposals, ...repeats]) {
      if (this.files.get(edit.file)?.text.slice(edit.start, edit.end) === edit.before)
        this.proposals.push(edit);
    }
    this.proposals = this.proposals.slice(-30);
    return this.proposals;
  }
  edits(): LinkedEdit[] {
    return this.proposals;
  }

  private functions(source: ts.SourceFile): Map<string, ts.FunctionLikeDeclaration> {
    const result = new Map<string, ts.FunctionLikeDeclaration>();
    const ambiguous = new Set<string>();
    const add = (key: string, value: ts.FunctionLikeDeclaration) => {
      if (result.has(key)) {
        result.delete(key);
        ambiguous.add(key);
      } else if (!ambiguous.has(key)) result.set(key, value);
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.body
      ) {
        const parent =
          ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent)
            ? node.parent.name?.text + '.'
            : '';
        const key = parent + node.name.text;
        // 同名局部函数有歧义时不做联动推断。
        add(key, node);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        add(node.name.text, node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return result;
  }

  private planSignatures(
    program: ts.Program,
    oldSource: ts.SourceFile,
    newSource: ts.SourceFile,
    oldFile: IndexedFile,
    newFile: IndexedFile,
  ): LinkedEdit[] {
    const checker = program.getTypeChecker();
    const before = this.functions(oldSource);
    const after = this.functions(newSource);
    const edits: LinkedEdit[] = [];
    const shift = this.changeSpan(oldFile.text, newFile.text);
    for (const [name, original] of before) {
      const updated = after.get(name);
      if (
        !updated ||
        original.parameters.some((p) => !ts.isIdentifier(p.name) || p.dotDotDotToken) ||
        updated.parameters.some((p) => !ts.isIdentifier(p.name) || p.dotDotDotToken)
      )
        continue;
      const oldNames = original.parameters.map((p) => p.name.getText(oldSource));
      const newNames = updated.parameters.map((p) => p.name.getText(newSource));
      if (oldNames.join(',') === newNames.join(',') || new Set(newNames).size !== newNames.length)
        continue;
      // 仅重命名形参不需要修改实参；同时出现删除与新增名称时无法证明是重排，跳过。
      if (
        oldNames.some((name) => !newNames.includes(name)) &&
        newNames.some((name) => !oldNames.includes(name))
      )
        continue;
      for (const target of program.getSourceFiles()) {
        if (!this.files.has(target.fileName)) continue;
        if (
          target.fileName !== oldFile.path &&
          target.text !== this.files.get(target.fileName)?.text
        )
          continue;
        const visit = (node: ts.Node) => {
          if (edits.length >= 12) return;
          if (
            ts.isCallExpression(node) &&
            checker.getResolvedSignature(node)?.declaration === original &&
            node.arguments.length === oldNames.length &&
            !node.arguments.some(ts.isSpreadElement)
          ) {
            const args: string[] = [];
            let safe = true;
            for (const [index, parameter] of updated.parameters.entries()) {
              const previousIndex = oldNames.indexOf(newNames[index]);
              if (previousIndex >= 0) {
                if (previousIndex !== index && !this.pureArgument(node.arguments[previousIndex])) {
                  safe = false;
                  break;
                }
                args.push(node.arguments[previousIndex].getText(target));
              } else if (parameter.questionToken || parameter.initializer) {
                if (index < newNames.length - 1) {
                  safe = false;
                  break;
                }
              } else {
                // 新增参数仅使用调用处已存在的同名简单绑定；没有证据时不编造业务值。
                const local = checker
                  .getSymbolsInScope(node, ts.SymbolFlags.Value)
                  .find((symbol) => symbol.name === newNames[index]);
                const declaration = local?.valueDeclaration;
                const expectedType = parameter.type?.getText(newSource);
                const localType =
                  local && declaration
                    ? checker.typeToString(checker.getTypeOfSymbolAtLocation(local, node))
                    : '';
                if (
                  !local ||
                  !declaration ||
                  (declaration.getSourceFile() === target &&
                    ts.isVariableDeclaration(declaration) &&
                    declaration.getStart() > node.getStart()) ||
                  (expectedType && expectedType !== localType)
                ) {
                  safe = false;
                  break;
                }
                args.push(newNames[index]);
              }
            }
            for (let index = 0; index < oldNames.length; index++)
              if (!newNames.includes(oldNames[index]) && !this.pureArgument(node.arguments[index]))
                safe = false;
            if (safe) {
              let start = node.arguments.pos;
              let end = node.arguments.end;
              if (target.fileName === oldFile.path) {
                if (start >= shift.oldEnd) {
                  start += shift.delta;
                  end += shift.delta;
                } else if (end > shift.start) {
                  ts.forEachChild(node, visit);
                  return;
                }
              }
              const targetFile =
                target.fileName === oldFile.path ? newFile : this.files.get(target.fileName)!;
              const beforeText = targetFile.text.slice(start, end);
              const afterText = args.join(', ');
              if (beforeText !== afterText)
                edits.push({
                  id: positionKey(target.fileName, start),
                  file: target.fileName,
                  version: targetFile.version,
                  start,
                  end,
                  before: beforeText,
                  after: afterText,
                  kind: 'signature',
                  sourceFile: oldFile.path,
                  reason: `${name} 参数从 (${oldNames.join(', ')}) 改为 (${newNames.join(', ')})；此处绑定到同一声明。`,
                });
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(target);
      }
    }
    return edits;
  }

  private pureArgument(node: ts.Expression): boolean {
    return (
      ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
        node.kind,
      )
    );
  }
  private changeSpan(before: string, after: string) {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let oldEnd = before.length;
    let newEnd = after.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    return { start, oldEnd, newEnd, delta: after.length - before.length };
  }

  private planRepeats(
    program: ts.Program,
    oldSource: ts.SourceFile,
    newSource: ts.SourceFile,
    oldFile: IndexedFile,
    newFile: IndexedFile,
  ): LinkedEdit[] {
    const span = this.changeSpan(oldFile.text, newFile.text);
    if (span.oldEnd - span.start > 100 || span.newEnd - span.start > 100) return [];
    const find = (source: ts.SourceFile, start: number, end: number): ts.Node | undefined => {
      let found: ts.Node | undefined;
      const visit = (node: ts.Node) => {
        if (node.getStart(source) <= start && node.end >= end) {
          found = node;
          ts.forEachChild(node, visit);
        }
      };
      visit(source);
      return found;
    };
    const oldNode = find(oldSource, span.start, span.oldEnd);
    const newNode = find(newSource, span.start, span.newEnd);
    if (!oldNode || !newNode || oldNode.kind !== newNode.kind) return [];
    const checker = program.getTypeChecker();
    const scope = (node: ts.Node): ts.Node => {
      let current = node.parent;
      while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current))
        current = current.parent;
      return current;
    };
    const container = scope(oldNode);
    const proof = (node: ts.Node): string | undefined => {
      if (
        ts.isIdentifier(node) &&
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node &&
        ts.isIdentifier(node.parent.expression)
      ) {
        const symbol = checker.getSymbolAtLocation(node.parent.expression);
        const definition = symbol?.valueDeclaration;
        if (definition) return `receiver:${definition.getStart()}:${node.getText()}`;
      }
      if (
        (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) &&
        ts.isPropertyAssignment(node.parent)
      )
        return `property:${node.parent.name.getText()}:${node.getText()}`;
      return undefined;
    };
    const key = proof(oldNode);
    if (!key) return [];
    const replacement = newNode.getText(newSource);
    const edits: LinkedEdit[] = [];
    const line = oldSource.getLineAndCharacterOfPosition(oldNode.getStart()).line;
    const visit = (node: ts.Node) => {
      if (
        node !== oldNode &&
        node.kind === oldNode.kind &&
        scope(node) === container &&
        proof(node) === key &&
        Math.abs(oldSource.getLineAndCharacterOfPosition(node.getStart()).line - line) <= 80 &&
        edits.length < 4
      ) {
        let start = node.getStart();
        let end = node.end;
        if (start >= span.oldEnd) {
          start += span.delta;
          end += span.delta;
        } else if (end > span.start) return;
        edits.push({
          id: positionKey(oldFile.path, start),
          file: oldFile.path,
          version: newFile.version,
          start,
          end,
          before: newFile.text.slice(start, end),
          after: replacement,
          kind: 'repeat',
          sourceFile: oldFile.path,
          reason: `同一作用域、相邻 80 行内存在相同${key.startsWith('receiver') ? '接收对象的属性访问' : '配置属性值'}，可应用刚才的 ${oldNode.getText()} → ${replacement} 修改。`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(container);
    return edits;
  }
}

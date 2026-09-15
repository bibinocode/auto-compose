const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 在真实 Extension Host 中执行，所有配置与样例只属于 runner 创建的隔离用户目录。
exports.run = async () => {
  const report = [];
  const apiKey = process.env.AUTO_COMPOSE_TEST_KEY;
  const providerId = apiKey ? 'deepseek-live-test' : 'host-test';
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, '扩展必须能被发现');
  const api = await extension.activate();
  assert.equal(api.version, 1);
  report.push('扩展激活与公开 API');
  const config = vscode.workspace.getConfiguration('autoCompose');
  await config.update('provider', providerId, vscode.ConfigurationTarget.Global);
  await config.update('debounceMs', 0, vscode.ConfigurationTarget.Global);
  await config.update('minRequestIntervalMs', 0, vscode.ConfigurationTarget.Global);
  await vscode.workspace
    .getConfiguration('editor')
    .update('inlineSuggest.enabled', true, vscode.ConfigurationTarget.Global);
  let calls = 0;
  let completed = 0;
  let latestRequest;
  // 各语言夹具验证注释传递与多行接受，不依赖安装相应语言服务器。
  const commentCases = [
    ['javascript', '// TODO: 求和\nconst sum = ', '(a, b) => {\n  return a + b;\n};'],
    [
      'typescript',
      '/** 求和 */\nexport const sum = ',
      '(a: number, b: number) => {\n  return a + b;\n};',
    ],
    ['java', '// TODO: 求和\npublic static int ', 'sum(int a, int b) {\n  return a + b;\n}'],
    ['go', '// TODO: 求和\nfunc ', 'sum(a, b int) int {\n  return a + b\n}'],
    ['rust', '/// TODO: 求和\npub fn ', 'sum(a: i32, b: i32) -> i32 {\n  a + b\n}'],
    ['cpp', '/* TODO: 求和 */\nint ', 'sum(int a, int b) {\n  return a + b;\n}'],
  ];
  const client = apiKey
    ? new (require('../artifacts/provider-client.cjs').HttpCompletionProvider)({
        id: 'deepseek',
        baseUrl: 'https://api.deepseek.com/beta',
        model: 'deepseek-flash',
        protocol: 'fim',
      })
    : undefined;
  const provider = {
    id: providerId,
    displayName: '宿主测试 Provider',
    requiresApiKey: false,
    async complete(request, context) {
      calls++;
      latestRequest = request;
      const fixture = commentCases.find(
        (item) => item[0] === request.languageId && item[1] === request.prefix,
      );
      if (!client && fixture) {
        completed++;
        return fixture[2];
      }
      if (!client) assert.ok(request.prefix.includes('return') || request.languageId === 'python');
      const text = client
        ? await client.complete(request, { ...context, apiKey })
        : request.languageId === 'python'
          ? 'fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)'
          : 'a + b';
      completed++;
      return text;
    },
  };
  if (client)
    provider.stream = async function* (request, context) {
      calls++;
      latestRequest = request;
      yield* client.stream(request, { ...context, apiKey });
      completed++;
    };
  const registration = api.registerProvider(provider);
  try {
    const doc = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: 'function add(a, b) {\n  return ;\n}\n',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(1, 9), new vscode.Position(1, 9));
    await vscode.commands.executeCommand('autoCompose.trigger');
    const deadline = Date.now() + 15000;
    while (!completed && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(calls > 0, '真实编辑器必须调用补全 Provider');
    // 命令返回与灰字渲染不在同一事件循环，等待工作台完成候选渲染再接受。
    await new Promise((resolve) => setTimeout(resolve, 350));
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    assert.ok(doc.getText().includes('return a + b;'), `补全接受后文本不正确: ${doc.getText()}`);
    report.push('真实行内灰字触发、接受、行尾保留');
    await vscode.commands.executeCommand('autoCompose.pause');
    const before = calls;
    await vscode.commands.executeCommand('autoCompose.trigger');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(calls, before);
    report.push('暂停期间不触发服务请求');
    await vscode.commands.executeCommand('autoCompose.resume');
    await vscode.commands.executeCommand('autoCompose.openPanel');
    await vscode.commands.executeCommand('autoCompose.diagnostics');
    report.push('侧边栏与诊断命令可用');
    const python = await vscode.workspace.openTextDocument({
      language: 'python',
      content: '# TODO: 写一下斐波函数\ndef ',
    });
    const pythonEditor = await vscode.window.showTextDocument(python);
    const pythonPosition = python.positionAt(python.getText().length);
    pythonEditor.selection = new vscode.Selection(pythonPosition, pythonPosition);
    const beforePython = completed;
    await vscode.commands.executeCommand('autoCompose.trigger');
    const pythonDeadline = Date.now() + 15000;
    while (completed === beforePython && Date.now() < pythonDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.ok(latestRequest.prefix.includes('# TODO: 写一下斐波函数\ndef '));
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    assert.ok(
      /def \w+\([^\n]*\):\n[ \t]+/.test(python.getText()),
      'TODO 补全应保留函数签名和缩进函数体',
    );
    report.push('Python 中文 TODO 与 def 空格触发并接受多行函数');
    if (!client) {
      for (const [language, prefix, code] of commentCases) {
        const document = await vscode.workspace.openTextDocument({ language, content: prefix });
        const view = await vscode.window.showTextDocument(document);
        const cursor = document.positionAt(prefix.length);
        view.selection = new vscode.Selection(cursor, cursor);
        const previous = completed;
        await vscode.commands.executeCommand('autoCompose.trigger');
        const deadline = Date.now() + 15000;
        while (completed === previous && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(latestRequest.prefix, prefix);
        await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
        assert.equal(
          document.getText().replaceAll('\r\n', '\n'),
          prefix + code,
          `${language} 多行接受`,
        );
      }
      report.push('JS/TS/Java/Go/Rust/C++ 注释驱动半行声明与多行接受');
    }
    if (client) {
      const indexDeadline = Date.now() + 15000;
      while (!api.getProjectStatus().ready && Date.now() < indexDeadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'usage.ts');
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from("const accountId = '123';\n// 获取账户详情\nconst account = "),
      );
      const usage = await vscode.workspace.openTextDocument(uri);
      const view = await vscode.window.showTextDocument(usage);
      const position = usage.positionAt(usage.getText().length);
      view.selection = new vscode.Selection(position, position);
      const previousCompletions = completed;
      await vscode.commands.executeCommand('autoCompose.trigger');
      const deadline = Date.now() + 15000;
      while (completed === previousCompletions && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.ok(
        latestRequest.context?.some((snippet) => snippet.content.includes('fetchAccount')),
        '实际模型请求应携带未打开文件的函数签名',
      );
      await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
      assert.ok(usage.getText().includes('fetchAccount('), '真实模型应使用项目中已有的函数');
      report.push('真实 DeepSeek 根据未打开文件的函数签名生成项目调用');
    }
    // 以下验证本地项目能力，暂停远端补全，避免触发不必要的模型请求。
    await vscode.commands.executeCommand('autoCompose.pause');
    const until = async (check, label) => {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        const result = await check();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`等待超时：${label}`);
    };
    await until(() => api.getProjectStatus().ready, '项目索引构建');
    console.log('HOST_INDEX', JSON.stringify(api.getProjectStatus()));
    const folder = vscode.workspace.workspaceFolders[0].uri;
    const apiUri = vscode.Uri.joinPath(folder, 'api.ts');
    assert.equal(
      vscode.workspace.textDocuments.some(
        (document) => document.uri.toString() === apiUri.toString(),
      ),
      false,
      '索引不应打开接口文件',
    );
    const consumer = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder, 'consumer.ts'),
    );
    await vscode.window.showTextDocument(consumer);
    const candidates = await until(async () => {
      const result = await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        consumer.uri,
        consumer.positionAt(consumer.getText().length),
      );
      return result.items.find(
        (item) => item.label === 'fetchAccount' && item.detail?.includes('项目符号'),
      );
    }, '未打开文件的项目符号联想');
    assert.ok(candidates.additionalTextEdits.some((edit) => edit.newText.includes("from './api'")));
    report.push('未打开接口文件的函数联想与导入建议');
    const apiDocument = await vscode.workspace.openTextDocument(apiUri);
    const signature = apiDocument.getText().indexOf('id: number, label: string');
    const transaction = new vscode.WorkspaceEdit();
    transaction.replace(
      apiUri,
      new vscode.Range(
        apiDocument.positionAt(signature),
        apiDocument.positionAt(signature + 'id: number, label: string'.length),
      ),
      'label: string, id: number',
    );
    await vscode.workspace.applyEdit(transaction);
    const caller = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder, 'caller.ts'),
    );
    const lenses = async (document) =>
      (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', document.uri)).filter(
        (lens) => lens.command?.command === 'autoCompose.previewLinkedEdit',
      );
    const signatureEdits = await until(async () => {
      const value = await lenses(caller);
      return value.length === 2 ? value : undefined;
    }, '跨文件签名联动');
    assert.equal(
      await vscode.commands.executeCommand(
        'autoCompose.applyLinkedEdit',
        signatureEdits[0].command.arguments[0],
      ),
      true,
    );
    const rest = await until(async () => {
      const value = await lenses(caller);
      return value.length === 1 ? value : undefined;
    }, '接受后的剩余调用建议');
    assert.equal(
      await vscode.commands.executeCommand(
        'autoCompose.applyLinkedEdit',
        rest[0].command.arguments[0],
      ),
      true,
    );
    assert.ok(caller.getText().includes("send('one', 1)"));
    assert.ok(caller.getText().includes("send('two', 2)"));
    report.push('函数签名重排后跨文件调用更新及连续接受');
    const repeated = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder, 'repeat.ts'),
    );
    const offset = repeated.getText().indexOf('100');
    const change = new vscode.WorkspaceEdit();
    change.replace(
      repeated.uri,
      new vscode.Range(repeated.positionAt(offset), repeated.positionAt(offset + 3)),
      '2000',
    );
    await vscode.workspace.applyEdit(change);
    const repeatEdits = await until(async () => {
      const value = await lenses(repeated);
      return value.length === 2 ? value : undefined;
    }, '同文件重复修改');
    await vscode.commands.executeCommand(
      'autoCompose.applyLinkedEdit',
      repeatEdits[0].command.arguments[0],
    );
    const nextRepeat = await until(async () => {
      const value = await lenses(repeated);
      return value.length === 1 ? value : undefined;
    }, '相邻建议重定位');
    await vscode.commands.executeCommand(
      'autoCompose.applyLinkedEdit',
      nextRepeat[0].command.arguments[0],
    );
    assert.equal((repeated.getText().match(/2000/g) ?? []).length, 3);
    report.push('同文件重复修改、相邻联动与接受后重定位');
  } finally {
    registration.dispose();
  }
  fs.writeFileSync(
    path.resolve(
      __dirname,
      apiKey ? '../artifacts/host-live-test-result.json' : '../artifacts/host-test-result.json',
    ),
    JSON.stringify(
      { passed: report, vscode: vscode.version, liveDeepSeek: Boolean(apiKey) },
      null,
      2,
    ),
  );
  console.log('HOST_TEST_PASS', JSON.stringify(report));
};

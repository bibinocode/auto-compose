/* 侧边栏只负责展示与表单，不持有密钥，也不直接访问网络。 */
(() => {
  const vscode = acquireVsCodeApi();
  const form = document.getElementById('settings-form');
  const feedback = document.getElementById('feedback');
  const save = document.getElementById('save');
  let dirty = false;
  let revision = -1;
  let providerSignature = '';
  let edits = 0;
  let submittedEdit = 0;
  const fields = [
    'projectIndex',
    'projectContext',
    'linkedEdits',
    'provider',
    'baseUrl',
    'model',
    'protocol',
    'multiline',
    'debounceMs',
    'minRequestIntervalMs',
    'maxTokens',
    'maxLines',
    'timeoutMs',
    'streaming',
    'cacheEnabled',
    'contextMode',
    'useDefinitions',
    'contextChars',
  ];
  const phaseLabels = {
    ready: '准备就绪',
    debouncing: '等待输入',
    context: '整理上下文',
    loading: '正在生成',
    paused: '已暂停',
    disabled: '已关闭',
    key: '待连接',
    error: '请求失败',
    cooldown: '服务冷却中',
  };
  const feedbackText = (text, error = false) => {
    feedback.textContent = text;
    feedback.classList.toggle('error', error);
    document.getElementById('save-bar').hidden = !dirty && !error;
  };
  const visibility = () => {
    const provider = form.elements.namedItem('provider').value;
    document.getElementById('endpoint-fields').hidden = !['deepseek', 'openai-compatible'].includes(
      provider,
    );
    document.getElementById('protocol-field').hidden = provider !== 'openai-compatible';
  };
  form.addEventListener('input', () => {
    dirty = true;
    edits++;
    syncPresets();
    feedbackText('有未保存的更改');
  });
  // 预设只修改当前表单，保存沿用已有校验；不触碰服务地址和密钥。
  const presets = {
    fast: {
      debounceMs: 80,
      minRequestIntervalMs: 180,
      maxTokens: 128,
      maxLines: 8,
      contextChars: 2000,
    },
    balanced: {
      debounceMs: 150,
      minRequestIntervalMs: 250,
      maxTokens: 256,
      maxLines: 12,
      contextChars: 4000,
    },
    complete: {
      debounceMs: 200,
      minRequestIntervalMs: 350,
      maxTokens: 512,
      maxLines: 24,
      contextChars: 6000,
    },
  };
  const syncPresets = () =>
    document.querySelectorAll('[data-preset]').forEach((button) => {
      const matches =
        Object.entries(presets[button.dataset.preset]).every(
          ([key, value]) => Number(form.elements.namedItem(key).value) === value,
        ) &&
        form.elements.namedItem('streaming').checked &&
        form.elements.namedItem('multiline').value === 'auto';
      button.setAttribute('aria-pressed', String(matches));
    });
  document.querySelectorAll('[data-preset]').forEach((button) =>
    button.addEventListener('click', () => {
      for (const [key, value] of Object.entries(presets[button.dataset.preset]))
        form.elements.namedItem(key).value = value;
      form.elements.namedItem('streaming').checked = true;
      form.elements.namedItem('multiline').value = 'auto';
      dirty = true;
      edits++;
      syncPresets();
      feedbackText(`已选择${button.dataset.label}，保存后生效`);
    }),
  );
  document.getElementById('provider').addEventListener('change', () => {
    const deepseek = form.elements.namedItem('provider').value === 'deepseek';
    form.elements.namedItem('baseUrl').value = deepseek ? 'https://api.deepseek.com/beta' : '';
    form.elements.namedItem('model').value = deepseek ? 'deepseek-flash' : '';
    visibility();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const settings = {};
    for (const name of fields) {
      const field = form.elements.namedItem(name);
      settings[name] =
        field.type === 'checkbox'
          ? field.checked
          : field.type === 'number'
            ? Number(field.value)
            : field.value;
    }
    save.disabled = true;
    submittedEdit = edits;
    feedbackText('正在保存…');
    vscode.postMessage({ type: 'save', settings });
  });
  // 隐藏在折叠区域中的无效字段先展开，浏览器才能聚焦并显示校验提示。
  form.addEventListener(
    'invalid',
    (event) => {
      let parent = event.target.closest('details');
      while (parent) {
        parent.open = true;
        parent = parent.parentElement.closest('details');
      }
    },
    true,
  );
  document
    .querySelectorAll('[data-command]')
    .forEach((button) =>
      button.addEventListener('click', () =>
        vscode.postMessage({ type: 'command', command: button.dataset.command }),
      ),
    );
  document.querySelectorAll('[data-tab]').forEach((button) =>
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((tab) => {
        const selected = tab === button;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', String(selected));
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.hidden = panel.id !== button.dataset.tab;
      });
      vscode.setState({ tab: button.dataset.tab });
    }),
  );
  const oldState = vscode.getState();
  if (oldState?.tab === 'activity') document.querySelector('[data-tab="activity"]').click();
  if (/Mac/i.test(navigator.platform))
    document.getElementById('shortcut').textContent = '⌘ Alt Space';
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'saved') {
      dirty = edits !== submittedEdit;
      save.disabled = false;
      feedbackText(dirty ? '仍有未保存的更改' : '偏好已保存');
      return;
    }
    if (data.type === 'error') {
      save.disabled = false;
      feedbackText(data.message, true);
      return;
    }
    if (data.type !== 'state') return;
    const { settings, stats } = data;
    document.getElementById('last-source').textContent =
      { network: '模型生成', cache: '本地缓存', reuse: '续写复用' }[data.lastSource] ?? '—';
    for (const [key, value] of Object.entries(data.usage ?? {})) {
      const element = document.getElementById(`usage-${key}`);
      if (element) element.textContent = String(value);
    }
    document.getElementById('unknown-usage').hidden = !(data.usage?.unknownRequests > 0);
    document.getElementById('balance-state').textContent =
      !data.balance || data.balance === '尚未查询' ? '点击刷新查看余额' : data.balance;
    document.getElementById('index-state').textContent = !settings.projectIndex
      ? '项目索引已关闭'
      : data.index?.ready
        ? `已索引 ${data.index.files} 个文件 · ${data.index.symbols} 个导出符号`
        : '项目索引构建中；普通补全仍可使用';
    const phase =
      data.phase === 'ready' && !data.hasKey && data.requiresKey !== false ? 'key' : data.phase;
    document.getElementById('phase').textContent = ['debouncing', 'context', 'loading'].includes(
      phase,
    )
      ? '正在补全'
      : (phaseLabels[phase] ?? '准备就绪');
    document.getElementById('phase').dataset.phase = phase;
    document.getElementById('model-label').textContent =
      data.providers.find((provider) => provider.id === settings.provider)?.displayName ??
      settings.provider;
    document.getElementById('detail').textContent =
      !data.hasKey && data.requiresKey !== false
        ? '连接你的模型，开始代码补全。'
        : data.phase === 'ready'
          ? '写下想法，补全接着来。'
          : ['debouncing', 'context', 'loading'].includes(data.phase)
            ? '正在续写你的思路…'
            : data.detail;
    document.getElementById('key-state').textContent =
      data.requiresKey === false
        ? '● 此服务无需密钥'
        : data.hasKey
          ? '● 密钥已保存'
          : '○ 尚未保存密钥';
    document.getElementById('key-action').textContent = data.hasKey ? '更换密钥' : '连接服务';
    document.getElementById('key-action').hidden = data.requiresKey === false;
    document.getElementById('toggle').textContent = settings.enabled ? '关闭' : '开启';
    const pause = document.getElementById('pause');
    pause.dataset.command = data.paused ? 'resume' : 'pause';
    pause.firstChild.textContent = data.paused ? '恢复自动补全 ' : '暂停 10 分钟 ';
    for (const [key, value] of Object.entries(stats)) {
      const element = document.getElementById(`stat-${key}`);
      if (element)
        element.textContent = key.endsWith('Ms') ? (value ? `${value} ms` : '—') : String(value);
    }
    const signature = JSON.stringify(data.providers);
    if (signature !== providerSignature) {
      const select = document.getElementById('provider');
      const previous = select.value;
      select.replaceChildren(
        ...data.providers.map((provider) => {
          const option = document.createElement('option');
          option.value = provider.id;
          option.textContent = provider.displayName;
          return option;
        }),
      );
      if (data.providers.some((provider) => provider.id === previous)) select.value = previous;
      providerSignature = signature;
    }
    // 状态更新不能覆盖用户正在填写的表单；配置修订变化只在没有未保存更改时同步。
    if (!dirty && revision !== data.revision) {
      for (const name of fields) {
        const field = form.elements.namedItem(name);
        if (field.type === 'checkbox') field.checked = settings[name];
        else field.value = settings[name];
      }
      revision = data.revision;
      visibility();
      syncPresets();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();

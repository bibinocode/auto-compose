# Auto Compose

让下一行，自然发生。

Auto Compose 是一个 VS Code AI 代码补全扩展。写代码或用注释描述需求，即可获得行内建议；按 **Tab** 接受，按 **Esc** 隐藏。默认使用 DeepSeek，只需配置 API Key。

## 能做什么

- **代码续写**：根据光标前后的代码补全表达式、函数和代码块。
- **注释生成代码**：参考 TODO、中文需求和文档注释生成实现，支持多种语言。
- **理解项目**：检索项目中已有的函数，为 TS / JS 提供未打开文件的函数联想和导入建议。
- **关联修改**：为函数签名变更、相邻重复修改提供可预览的更新建议。
- **查看用量**：记录本机累计 token，支持查询 DeepSeek 账户余额。

项目索引和结构化联动目前主要支持 TS / JS；其他语言可使用代码与注释补全。AI 建议仍需要你检查后接受。

## 开始使用

1. 安装扩展，点击活动栏中的 **Auto Compose**。
2. 点击 **连接服务**，输入 DeepSeek API Key。
3. 在代码文件中输入，停顿片刻即可看到灰字建议。

| 操作 | 快捷键 |
| --- | --- |
| 接受补全 | `Tab` |
| 隐藏补全 | `Esc` |
| 手动触发 | Windows / Linux：`Ctrl+Alt+Space`；macOS：`Cmd+Alt+Space` |

在“偏好”中选择 **极速、均衡或完整**，点击保存即可调整补全节奏。更详细的参数位于“高级偏好”及 VS Code 设置中。

## 配置说明

以下配置使用 `autoCompose.` 前缀，例如 `autoCompose.maxTokens`。

### 模型与连接

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `provider` | `deepseek` | 服务商；可选 `openai-compatible` 或外部扩展注册的服务。 |
| `baseUrl` | 留空 | 服务基础地址。留空使用 DeepSeek；不要附加 `/completions`。 |
| `model` | 留空 | 模型名称。留空使用 `deepseek-flash`。 |
| `protocol` | `fim` | 兼容服务的协议：`fim` 为代码填空，`chat` 为指令补全。 |

使用官方 DeepSeek 时，普通续写采用 FIM，明确的实现类注释采用指令补全。自定义服务需填写地址和模型，并选择其支持的协议。

### 补全体验

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用代码补全。 |
| `multiline` | `auto` | `auto` 自动判断；`always` 允许多行；`never` 只生成一行。 |
| `debounceMs` | `150` | 停止输入后的等待时间，单位毫秒。 |
| `maxTokens` | `256` | 单次生成 token 上限；越大可生成的内容越长。 |
| `maxLines` | `12` | 单次补全最多保留的行数。 |
| `streaming` | `true` | 是否分段接收生成内容。 |
| `minRequestIntervalMs` | `250` | 同一服务两次请求的最小间隔，单位毫秒。 |
| `timeoutMs` | `15000` | 请求超时时间，单位毫秒。 |
| `cacheEnabled` | `true` | 复用已有候选，减少重复请求。 |

### 项目与上下文

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `projectIndex` | `true` | 在后台索引 TS / JS 项目函数。 |
| `projectContext` | `true` | 向模型补充相关项目函数签名和说明。 |
| `linkedEdits` | `true` | 显示可预览的关联修改建议。 |
| `indexMaxFiles` | `1500` | 项目索引的文件数量上限。 |
| `contextMode` | `current-file` | `open-files` 可额外参考最近打开的文件。 |
| `useDefinitions` | `false` | 使用语言服务补充符号定义。 |
| `contextChars` | `4000` | 关联内容的字符预算。 |
| `prefixChars` | `12000` | 光标前代码的字符预算。 |
| `suffixChars` | `4000` | 光标后代码的字符预算。 |
| `maxFileChars` | `500000` | 超过此字符数的文件不参与补全。 |
| `disabledLanguages` | `log`, `scminput` | 禁用补全的语言 ID。 |
| `excludePatterns` | 环境变量、密钥及依赖文件等 | 不参与补全的文件 glob；可在设置中查看完整默认列表。 |

API Key 保存在 VS Code 安全存储中。当前代码及启用的关联上下文会发送给所选服务；可用 `excludePatterns` 或工作区根目录的 `.autocomposeignore` 排除文件。

用量页显示服务实际返回的 token，重启后保留。取消或未返回用量的请求单独提示，累计值可能低于实际消耗；账户余额需点击刷新。

# Auto Compose 补全架构

## 本地 Continue 对照

本轮阅读了用户指定的 Continue 源码及其关联 core 实现，独立实现下面的设计，不复制 Continue 的业务代码：

| Continue 相对路径 | 参考点 | 本项目落点 |
| --- | --- | --- |
| `extensions/vscode/src/autocomplete/completionProvider.ts` | 编辑器状态检查、原生候选联动、候选接受 | `src/completion/inlineProvider.ts` |
| `extensions/vscode/src/autocomplete/GhostTextAcceptanceTracker.ts` | 在命令回调之前区分灰字接受与主动光标移动 | `src/completion/GhostTextAcceptanceTracker.ts` |
| `core/autocomplete/CompletionProvider.ts` | 上下文、生成、后处理、缓存的分层 | `src/completion/engine.ts` |
| `core/autocomplete/generation/GeneratorReuseManager.ts` | 输入命中已有候选时复用剩余部分 | `src/completion/reuse.ts` |
| `core/autocomplete/postprocessing/index.ts` | 去除包装、过滤重复、保留代码语义 | `src/completion/postprocess.ts` |
| `extensions/vscode/src/autocomplete/recentlyEdited.ts` | 最近编辑文件与片段 | `src/context/contextService.ts` |
| `extensions/vscode/src/autocomplete/lsp.ts` | 有界语言服务定义检索 | `src/context/contextService.ts` |
| `extensions/vscode/src/autocomplete/statusBar.ts` | 状态、暂停、快捷操作 | `src/ui/status.ts` |

## 请求链路

编辑器预过滤 → 局部上下文 / 可选关联文件与定义（消耗防抖窗口）→ 候选缓存与续写复用 → 未命中时等待防抖与节流的最大截止时间 → Provider → SSE / JSON → 长度控制与后处理 → 版本、光标双重验证 → 灰字候选 → 接受统计。

0.3.2 中缓存命中不等待网络防抖；空候选单独保存 2 秒，避免相同请求反复计费。上下文仍在缓存匹配前刷新，以免复用失效的项目信息。降低防抖也可能增加输入停顿期间的请求频率，可通过体验预设调整。当前稳定版行内 API 仍在完整候选就绪后返回，未实现边收 token 边刷新灰字。

- `extension.ts` 只负责组装服务、命令和释放资源。
- `config/` 集中定义默认值、校验与 SecretStorage 的密钥标识。
- `providers/` 管理内置和注入的 Provider；对外 API 保持 v1 向后兼容，新增可选流式方法。
- `completion/` 不在 HTTP 层访问编辑器，也不在候选层存储密钥。
- `context/` 仅检索当前工作区；关联文件功能由配置控制，不遍历全仓库。
- `ui/` 侧边栏仅发送白名单设置和操作，密钥在原生密码输入框中输入，不回传 Webview。
- `services/` 保存会话统计及状态；不保存补全代码、不发送遥测。
- `project/` 在 Worker 中维护有界 TS/JS 项目索引，索引未打开文件，解析导出符号、文档、模块关系与调用绑定。查询只发送高相关元数据给模型。
- `edits/` 提供 CodeLens、差异预览、单次应用和过期验证；用户认可的灰字作为编辑证据，联动补丁自身不再触发重复学习。

## 接受与联动时序

返回候选时记录文档 URI、版本、替换范围和预期文本 → 文档变化先验证实际替换事务 → 光标变化检查事务终点，优先于普通取消处理 → 命令回调兜底计数。部分接受会推进剩余候选快照；主动移动或不匹配的编辑清除期望。

签名联动用变更前 TypeScript 调用绑定确认目标，参数映射只处理明确重排、删除或同名同类型局部值可用的新增参数。纯形参重命名不改调用。带副作用的参数、重载歧义、解构/rest 和无法提供参数值的情况不自动猜测。

同文件联动只对同作用域、邻近 80 行内的相同接收对象属性访问或相同配置属性值生成最多 4 个建议。应用前比较当前文件完整快照及原始目标文本，接受后重定位剩余候选，保持撤销能力。

## 有意保留的边界

当前项目索引与结构化联动针对 TS/JS/TSX/JSX，其他语言仍使用普通 FIM 和可选 LSP 上下文。索引支持直接配置的 tsconfig 路径映射，但不实现完整的 tsconfig extends、project references、外部依赖分析或语言服务重构系统。局部联动不是通用模型 Next Edit，不包含 Agent、聊天、向量索引或任意跨文件批量重写。流式 API 用于增量解析与提前停止，稳定行内 API 在候选准备完毕后显示完整灰字。续写复用只使用已经完成的候选。

## 中文注释约定

公共接口、主要服务和关键方法使用中文说明；注释解释设计原因、边界、取消和资源释放，不逐句复述代码。协议字段、类型名、命令 ID 和外部 API 名称保持英文。

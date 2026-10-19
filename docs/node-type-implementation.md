# NodeType 的实现与首个节点验证方案

本文是 [Node 模型](node-model.md) 的代码落地说明，先用 LLM，再用图生视频检查同一套边界。基础接口和 React Flow 适配已实现；文中的模型选择、媒体引用和生产节点方案仍需后续确认，不表示已有可调用节点、插件或运行服务。

## 一个类型注册对象连接元数据与编译

服务端 `NodeTypeDefinition` 包含 type、可选 preset、displayName、category、独立 UI 描述，以及 Input / Output / Config 三个 Zod 对象 Schema。`NodeType` 将它与 compile 方法组合：

```ts
interface NodeType<State extends object, Update extends object> {
  readonly definition: NodeTypeDefinition;
  compile(
    node: NodeDefinition,
    context: CompileContext<State, Update>,
  ): LangGraphNode<State, Update>;
}
```

`NodeRegistry.register(nodeType)` 从 definition 读取唯一的 type / preset 身份；`get` 和 `compile` 使用同一份注册信息。不存在另一套独立维护的 UI 类型目录或按业务名称增加的 Compiler switch。`NodeContract` 是内部值校验所需的三个 Schema 与身份，完整 NodeTypeDefinition 在它之上补齐公开元数据。

普通操作使用 `createOperationNodeType(definition, operation)`，沿用输入校验、操作调用、输出校验和 RunnableConfig 透传。审核等控制节点可自己实现 compile，直接返回原生 LangGraph 节点函数，不强制经过普通操作工厂。

## 浏览器只读取可序列化声明

`createNodeTypeManifest` 白名单输出公开元数据、UI 描述和 Zod 原生生成的 JSON Schema。输入和配置明确使用 `io: 'input'`，输出使用 `io: 'output'`；不可表示的类型明确报错，不降成任意 JSON。使用独立的空 metadata registry，防止全局 `.meta()` 混入私有字段或覆盖生成的校验类型。[Zod 官方 JSON Schema 文档](https://zod.dev/json-schema) 说明了方向、元数据与转换限制。

Schema 的默认值和枚举仍可能出现在 JSON Schema 中，因此类型作者只能在 Schema 中声明公开的静态数据，不能嵌入账号、密钥或服务端连接配置。此函数不接收用户节点配置，不导出 compile、operation、模型实例或适配器；它不是对任意含密钥对象的自动脱敏器。JSON Schema 也不能表达所有 refine，服务端 Zod 校验仍是权威。

UI Schema 使用 component 字符串说明如何编辑字段。例如 prompt-editor、slider、model-selector 或 asset-picker；这些是声明协议，当前没有相应表单渲染器或选择器服务。UI 字段必须对应 configSchema 的真实顶层字段，滑块范围等自身也需校验。组件名称由前端受控映射，不能作为动态代码或远程模块地址执行。

React Flow 使用 `type: 'workflowNode'` 选择通用组件，真正的 Runtime 类型在 `data.nodeType`；Handle 对应声明的输入输出字段，不要求每个 Runtime 类型注册一个 React 组件。这符合 [React Flow 自定义节点机制](https://reactflow.dev/learn/customization/custom-nodes)。适配器保留绑定与 Preset，只导出白名单领域字段和 `ui.position`，不保存 selected、dragging、measured 等临时状态。当前尚未接入画布节点编辑和保存接口。

## 下一步的 LLMNode：先限定为文本输入与文本输出

第一个生产节点建议先采用以下职责划分，不同时引入 Agent、工具调用、结构化业务生成或全部聊天历史：

| 契约   | 字段方向                                                    | 边界                                                                 |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Input  | `prompt: string`、可选 `context: string`                    | 只接收明确绑定的本次输入；不自动加入整个 State 或项目聊天            |
| Output | `text: string`                                              | 模型结果必须转换并校验，不能把 SDK Message 实例直接写入 JSON State   |
| Config | 显式模型选择引用、可选 systemPrompt 与受支持的模型参数      | 系统提示词属于配置，本次 prompt 属于输入；厂商支持范围还要由插件校验 |
| UI     | 模型选择器、systemPrompt 的 prompt-editor、已支持参数的控件 | UI 描述不承担模型访问权限或后端参数校验                              |

模型选择必须能定位用户明确选中的 Plugin、Model 和 Credential。可以设计非敏感的 `{ pluginId, modelId, credentialId }`，也可以引用一个已版本化的选择记录；具体持久化形式留待插件与凭证边界确认。不能只保存一个有歧义的模型名称，再自动推断厂商或补上默认凭证。

“不保存 OpenAI / DeepSeek 模型信息”应理解为**不绑定厂商 SDK、连接实例或密钥**，并不意味着不能保存明确、非敏感的插件和模型标识。实例、密钥、解密结果、API 客户端与 BaseChatModel 都留在受信任服务端；凭证引用仍需按项目权限解析，知道引用不等于有调用权限。Run 的模型选择也必须固定，不能在恢复时自动换成最新版或其他厂商。

LLM 编译产物的具体链路为：

```text
NodeDefinition + 已固定的有效 NodeTypeDefinition
  → CompileContext 解析已选择的输入
  → Zod 校验 inputs / config
  → 受信任服务端插件校验选择、权限和模型参数
  → 取得 LangChain BaseChatModel
  → 显式构建 Messages 并传递 RunnableConfig / 取消信号
  → model.invoke(...)
  → 将支持的文本结果转换并按 outputSchema 校验
  → CompileContext 写出该节点的 State 增量
```

内部复用官方 [BaseChatModel](https://reference.langchain.com/javascript/langchain-core/language_models/chat_models/BaseChatModel) 和 Message 抽象，不新建一套 LLM.chat 接口。普通文本结果、内容块、工具调用和结构化输出必须明确处理；不能使用 String(message) 或静默丢弃未知结果来凑出 text。暂不支持的结果应明确失败。

生产 LLMNode 的实施前置项是模型选择引用、受信任插件解析、参数兼容和凭证权限。当前不注册返回固定文本的“可用 LLM 节点”，也不为缺少真实模型接入提供默认供应商。下一轮可先确定这些最小引用与依赖，再沿现有 NodeType 工厂接入 LangChain。

## 用图生视频复核抽象

图生视频仍复用同一个 NodeType 对象和通用 React Flow 组件，改变的是领域契约与操作实现：

| 维度     | LLM                                          | 图生视频                                            |
| -------- | -------------------------------------------- | --------------------------------------------------- |
| 输入     | prompt、显式 context                         | 版本化 Image Asset 引用、prompt                     |
| 输出     | text                                         | 版本化 Video Asset 引用                             |
| 配置     | 显式模型选择、受支持的文本参数               | 显式 Capability / Plugin 选择、时长等受支持视频参数 |
| UI       | 模型选择器、提示词、参数控件                 | 模型选择器、时长等参数；输入图由 Handle 绑定        |
| 内部调用 | LangChain BaseChatModel                      | Plugin 提供 ImageToVideo 能力                       |
| 执行适配 | 返回本节点输出，由 CompileContext 映射 State | 相同输出边界；异步受理、回调及 Queue 需要另行接入   |

图生视频可以是专门的 Runtime 类型，不必伪装成 LLM 或万能 HTTP 节点；Kling、Veo 等是可选择的提供方，不是节点类型本身。耗时异步任务不能靠节点内轮询、内存计时器或假视频地址冒充接入。媒体引用依赖 Asset 模型，异步等待依赖原生 LangGraph 恢复与作业服务，当前都不通过占位实现提前固定。

本轮确认 NodeType 的组合和序列化边界，先细化 LLMNode 并用图生视频交叉验证，再进入完整 State / Binding。`nodeOutputs[nodeId]` 是可讨论的状态方向；其 reducer、批量调用身份和并行冲突规则未定，不能简单对象覆盖或据此宣称已实现数据流。

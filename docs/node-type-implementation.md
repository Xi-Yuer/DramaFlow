# NodeType 静态说明书与实施边界

NodeTypeDefinition 描述节点类型的静态能力和契约，不保存某次工作流的输入值、参数值、执行状态或服务连接。本文维护八项声明及代码适配；实例、Preset 与 NodeRun 的关系见 [Node 模型](node-model.md)，下一步统一见 [实施方案](implementation-plan.md)。

## 八项职责

| 字段         | 回答的问题         | 当前边界                                                           |
| ------------ | ------------------ | ------------------------------------------------------------------ |
| type         | 这是什么节点类型   | 稳定命名空间 ID，例如 ai.llm、video.image_to_video，不能使用展示名 |
| version      | 使用哪个类型版本   | 正整数；实例 / Preset 的 typeVersion 必须明确引用                  |
| metadata     | 如何向用户介绍     | name、可选 description、category、可选 icon，无执行逻辑            |
| inputs       | 接收哪些工作流数据 | key、name、DataType 及可选 required / multiple / defaultValue      |
| outputs      | 产生哪些工作流数据 | key、name、DataType 及可选 multiple                                |
| configSchema | 哪些执行配置合法   | 服务端 Zod 对象 Schema，不包含实例实际值                           |
| capabilities | 需要什么外部能力   | 可选稳定能力类型列表，不能重复，不包含厂商或凭证选择               |
| ui           | 如何表达编辑提示   | 可选 color、inputs、config；控件由前端受控映射                     |

contracts 的 NodeTypeDeclaration 保存除 configSchema 外的纯 JSON 声明；workflow 的 NodeTypeDefinition 在它之上加入服务端 configSchema。这个说明书不继承内部 NodeContract，也不包含 inputSchema / outputSchema 或 Preset ID。

metadata.name 可以随展示文案调整，type 保持稳定。metadata.icon 和 ui.color 只是安全标识，不是 React 组件或执行代码。命名空间规则仅约束类型与能力 ID，不收紧工作流、节点或运行记录的实例 ID。

## DataType 与运行校验

DataType 的当前集合为 string、number、boolean、image、video、audio、domain{name}、array{item}。领域名称使用稳定标识，数组递归描述元素；不包含 Zod 实例、文件内容或服务连接。

isDataTypeAssignable 只做结构兼容判断，不做类型转换：Image → Image 可以，Video → Image 不可以，domain 名称必须一致，数组元素逐层匹配。它不检查整张图，也不校验真实媒体值或资产权限。

运行输入输出由独立 NodeValueSchemas 显式提供 Zod 对象 Schema。assertNodePortSchemas 检查它们的字段名与说明书端口 key 集合一致，不能从两个同名字段推断类型或约束完全一致。媒体及领域资料的运行契约还依赖 Asset 等模型，不提供 URL、任意对象或测试结果兜底。

端口 required / defaultValue / multiple 是当前静态声明。defaultValue 只验证 JSON 形状，不自动解析为固定输入或注入 LangGraph State；required 的运行校验仍来自显式值 Schema，后续需统一声明与运行语义。multiple 不等于数组类型，也不启用多来源绑定；集合值用 array 描述，多连接、收集与排序留给数据流设计。

## 输入与配置分开编辑

输入以是否参与工作流数据传递划分，不能按是否由用户手填来判断。prompt、首帧图片和可能动态传入的 duration 可以是 Input；节点执行参数由 configSchema 声明。模型、provider 和凭证选择的最终归属尚未确定，留待 Plugin / Capability 设计。

ui.inputs 的键必须属于输入端口，ui.config 的键必须属于 configSchema 的顶层字段；两份描述不能共用 ui.fields。组件可使用 textarea、prompt-editor、slider 等受控标识，slider 范围、select 选项等须满足声明校验。控件存在不意味着已有配置表单、资产选择器或模型选择服务。

InputPort.key 对应 target Handle.id，OutputPort.key 对应 source Handle.id；同方向拒绝重名，输入输出可以同名并通过 Handle 的方向区分。[React Flow Handles](https://reactflow.dev/learn/customization/handles) 提供原生端口和连线机制，平台不再实现另一套画布。

当前 NodeDefinition.inputs 仍是节点输出来源的 Binding 数组。固定值、Workflow Input、Asset、变量等 InputValue 尚未定义，本轮不把这些来源塞入 config，也不改成无约束的输入记录。实例布局继续位于 ui.position。

## 服务端注册与编译

普通操作注册链为：

```text
NodeTypeDefinition（声明 + configSchema）
+ NodeValueSchemas（inputSchema + outputSchema，可选 preset）
+ operation
    ↓ createOperationNodeType
NodeType（definition + 可选 preset + compile）
    ↓ NodeRegistry，按 type / version / preset 精确查找
NodeDefinition（type + typeVersion + 可选 preset）
    ↓ compile + CompileContext
LangGraph 节点函数
```

工厂将说明书的 type / version / configSchema 与显式运行值 Schema 组合成内部 NodeContract。Preset 选择属于注册对象与实例，不混入说明书；Registry 不自动选择最新版、默认 Preset 或替代类型。审核和控制类型可以直接实现 compile 并使用原生 LangGraph 机制。

CompileContext 负责读取输入与写出 State 更新，普通操作只处理自身值。完整 State / Binding、输入来源解析、Edge 派生规则及整图编译尚未实现；节点操作校验与注册成功不表示工作流已经可执行。

## 浏览器 manifest

createNodeTypeManifest 白名单输出 NodeTypeDeclaration 加 configSchema 的 JSON Schema。端口继续使用 DataType，不再导出输入输出 Zod 的 JSON Schema。

配置转换采用 Zod 原生 toJSONSchema、input 方向、独立空 metadata registry 和不可表示即失败的策略；全局 .meta() 不进入 manifest，不能静默降为任意 JSON。[Zod JSON Schema 文档](https://zod.dev/json-schema) 说明转换方向及限制。JSON Schema 无法表达的 refine 等约束仍由服务端完整校验。

Schema 默认值、端口默认值、枚举及声明文本均可能公开，不能放入密钥、账号连接配置或供应商实例。manifest 不接收节点实际配置，不导出 operation / compile；它不是任意私有对象的自动脱敏器。前端只读取声明并使用受信任组件映射，不加载服务端 Zod。

React Flow 的渲染器 type 固定为 workflowNode，领域类型 / 版本在 data.nodeType / data.typeVersion。现有适配只转换白名单字段、绑定、Preset 和布局，未接入节点目录、UI 渲染、画布保存或 API。

## LLM 与图生视频的静态对照

以下仅用于检查声明职责，不定义生产类型目录或承诺下一步接入真实模型：

| 维度       | LLM                         | 图生视频                                      |
| ---------- | --------------------------- | --------------------------------------------- |
| type 示例  | ai.llm                      | video.image_to_video                          |
| 输入方向   | prompt 及显式选择的上下文   | 首帧图片、prompt，以及可能动态传入的 duration |
| 输出方向   | text                        | video                                         |
| DataType   | string 或明确的 domain 声明 | image、string、number、video 等声明           |
| 值校验依赖 | 显式文本 Zod 契约           | 尚需明确版本化媒体 / Asset 引用契约           |
| capability | 可声明文本生成能力          | 可声明图生视频能力                            |
| 插件边界   | 不固定模型厂商、连接或凭证  | 不固定 Kling、Veo 等供应商                    |

Capability 当前只是一份需求声明，没有 Resolver、自动 Routing、插件选择或模型调用。下一步聚焦 InputValue、State、Binding 与 Output 的数据流关系；生产节点、模型选择、资产和异步服务按后续明确范围推进。

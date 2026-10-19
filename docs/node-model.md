# Node 模型：③ 可调度执行单元

**Node 是 Workflow 中最小的逻辑执行单元，由 LangGraph 调度。** 它可以使用模型、视频领域能力、工具或控制逻辑。本文维护实例、类型、Preset、编译与运行记录的关系；静态说明书的八项职责见 [NodeType 实施说明](node-type-implementation.md)，技术分工见 [Runtime 架构](runtime-architecture.md)，实际能力见 [当前架构](architecture.md#node-基础库)。

## 统一原则

```text
React Flow Node（编辑视图）
    ↓
NodeDefinition（平台 DSL，固定 type + typeVersion）
    ↓
NodeRegistry → NodeType（definition + 可选 preset + compile）
    ↓
LangGraph Node Function → StateGraph.compile() → LangGraph 执行
    ↓
WorkflowRun / NodeRun（未来的业务记录投影）
```

平台 Compiler 把关系与契约映射到 LangGraph。编译生成的节点函数可以接收 State，适配层按 Binding 取出明确输入；普通值操作只收到自身 inputs / config 及 LangChain RunnableConfig，不自动取得完整图、其他节点结果或聊天。平台不自建 ready 轮询、暂停恢复状态机或图调度循环。

## 实例、类型、预设与执行记录

| 对象                  | 职责                            | 当前代码边界                                                              |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `NodeDefinition`      | 工作流内的静态节点实例          | id、type、typeVersion、name、inputs、config，以及可选 preset、ui.position |
| `NodeTypeDeclaration` | 可序列化的静态类型声明          | type、version、metadata、inputs、outputs、可选 capabilities、ui           |
| `NodeTypeDefinition`  | 服务端节点类型说明书            | NodeTypeDeclaration 加 configSchema；输入输出按端口 DataType 描述         |
| `NodeValueSchemas`    | 真实输入输出值校验              | 独立的 inputSchema / outputSchema，不充当公开端口类型                     |
| `NodeContract`        | 普通操作的内部有效契约          | type、version、可选 preset 与 Input / Output / Config 三组 Zod            |
| `NodeType`            | 服务端可编译能力                | definition、可选 preset 与 compile，作为 Registry 注册对象                |
| `NodePreset`          | 某个 Runtime 类型版本的场景配置 | id、type、typeVersion、name、可选 description 和 config，无执行器         |
| `NodeRun`             | 某次运行中的节点执行记录        | 输入、输出、结构化错误、时间与八种业务状态                                |

类型使用 `ai.llm`、`video.image_to_video` 等稳定命名空间标识。类型声明的 `version` 是正整数，实例与 Preset 通过必填 `typeVersion` 固定引用；展示名称修改不改变类型身份。节点实例 ID、WorkflowVersion ID 与节点类型版本各有职责，不互相替代。

NodeDefinition 的 config 在序列化边界只接受 JSON 记录，调用前再经所选类型的 configSchema 校验。布局只保存在 ui.position，不接收旧顶层 position。React Flow 的 type 是渲染器标识 workflowNode，领域类型及版本在 data.nodeType / data.typeVersion；双向转换保留绑定、Preset 和配置，剔除 selected、dragging、measured 等临时字段。当前没有节点渲染器、配置表单或画布保存接入。

## 端口类型、真实值与配置

Input / Output Port 以 key 对应 React Flow Handle.id，并分别检查同方向 key 唯一；同名输入与输出可以并存。DataType 是稳定的 JSON 类型声明，覆盖 string、number、boolean、image、video、audio、domain 和递归 array；它不等于 Zod，也不内含媒体文件、资产引用或校验函数。

isDataTypeAssignable 进行显式结构匹配：基础种类相同、domain 名称相同、array 元素递归匹配，不做隐式转换。这只是独立兼容判断，完整连线检查仍需结合节点版本、端口引用与图定义。真实值继续由显式 Zod 校验，不能从 image 类型猜成 URL 或伪造资产协议。

输入表示可参与工作流传递的数据；配置表示执行参数，不能按是否由用户手填来划分。duration 等可能动态变化的量可以声明为 Input；模型和供应商选择的最终位置留待 Plugin / Capability 设计，不在领域类型中写死厂商。

端口 required、defaultValue、multiple 目前只提供静态声明；默认值限定 JSON，不代表已按 DataType 校验或自动注入固定输入。multiple 不等于 array，也不授权同一目标端口多连接。UI 的 inputs / config 分开描述控件，分别引用输入端口和配置字段，不能以 UI 默认值或控件范围替代运行校验。

公开 manifest 由静态声明加配置 JSON Schema 构成，不导出输入输出 Zod、compile、模型实例或密钥。详细声明、配置转换及公开默认值边界集中在 [NodeType 实施说明](node-type-implementation.md)。

## InputBinding 与 Edge

当前实例 inputs 仍是 InputBinding 数组，一个绑定明确指向一个上游输出键：

```ts
{
  target: 'characters',
  source: { nodeId: 'characters', outputKey: 'items' }
}
```

来源键统一使用 outputKey，不保留 output 别名。节点可以分别将 script、characters、style 绑定到不同上游，不接收全部上游数据；同一 target 禁止重复绑定。InputValue 与固定值、Workflow Input、Asset、变量等多来源协议留给下一步，本轮不改为没有语义的任意记录。

Edge 保存 id、sourceNodeId、sourceHandle、targetNodeId、targetHandle。React Flow 原生连线经过适配变成这个平台协议；缺少端口时拒绝导出，不猜测映射。inputBindingFromEdge 仅提取数据投影，不激活下游。

执行关系决定激活，Binding 决定取值；数据具备不意味着条件分支已被选中，未选中分支应传播 skipped。Edge 与 Node.inputs 的编辑权威来源、派生规则、映射一致性、联合依赖无环，以及 fan-in / Send / reducer 的组合，在数据流步骤确定。当前类型兼容函数不替代这些规则。

## NodeCompiler 与普通操作

NodeCompiler 只声明 compile，NodeType 将说明书、可选 Preset 选择与编译方法组合。NodeRegistry 的 register / get / compile 按 `(type, version, preset)` 精确匹配，get 接受 type、version、可选 preset；不寻找最新版、不回退基础类型。类型身份来自 definition.type / definition.version，Preset 标识留在注册对象上，不混入类型说明书。

普通操作通过 createOperationNodeType(definition, valueSchemas, operation) 注册。valueSchemas 显式提供 inputSchema / outputSchema 和可选 preset；工厂将其与 configSchema 组合为内部 NodeContract。assertNodePortSchemas 只检查输入输出字段名与端口 key 集合一致，不从 Zod 推断 DataType，也不生成媒体值校验器。

编译时校验实例身份、目标端口和配置；LangGraph 调用节点函数时，CompileContext.readInputs 读取已组装值，invokeNodeOperation 校验输入 / 配置、调用操作、校验输出，再经 writeOutputs 返回 State 增量。接口保留 State / Update 泛型，不提前规定整个运行状态。

Definition / Preset 保留原始 JSON 配置；Schema 转换和默认值不回写定义，实际操作重新解析有效值，避免重复解析累积 transform。值与外部对象隔离，异常直接传播，不自动重试或替换插件；LangGraph interrupt 控制异常不能转成普通 failed。控制与审核类型可直接返回原生 Command / interrupt，不强制套用普通值操作工厂。

## Preset 与类型版本

相近的故事、剧本、广告文案等场景可以复用 Runtime 类型及执行机制，由 Preset、端口和配置表达差异，不为业务名称复制执行器。当前 Preset 显式保存所属 type / typeVersion 与配置；有效说明书、输入输出校验仍须由受信任注册对象提供。

applyNodePreset 检查类型版本和 Preset 身份，合并配置与实例覆盖后校验，不修改原对象、不运行节点、不选择厂商或凭证。找不到明确的类型版本或 Preset 时失败。

发布必须固定类型版本、有效端口契约、Preset 配置及所需编译实现；类型 version 不等于已有跨部署代码兼容管理。完整发布快照、Preset 不可变版本与编译实现保留策略仍需随持久化设计落实，不能运行时按可变 Preset ID 解析最新版。

## NodeRun 与领域边界

NodeRun 状态为 pending、ready、running、waiting、completed、failed、skipped、cancelled，是未来基于 LangGraph 执行事实生成的业务投影。当前只校验 JSON 输入输出、结构化 code / message、ISO 时间及记录形状，不处理调度、归属权限或持久化。

人工介入使用 LangGraph interrupt / Command.resume；根 WorkflowRun.id 绑定 thread_id，恢复加载原不可变版本并从节点函数开头重跑，生成副作用与审核分离。详细运行边界见 [Runtime 架构](runtime-architecture.md)。

## 视频领域能力与厂商边界

允许视频领域 Node、Tool、Schema 与 Asset Type 专业化。图生视频、字幕、合成、抽帧等能力可以有明确契约，用户选择的 Plugin 提供外部能力，不与单一厂商绑定。Runtime 通用、视频领域 Capability 专业化、上层模板场景化；当前不存在生产节点目录或固定 Runtime 类型枚举。

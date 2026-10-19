# Node 模型：③ 可调度执行单元

**Node 是 Workflow 中最小的逻辑执行单元，由 LangGraph 调度。** 它可以使用模型、领域能力、工具或控制逻辑，不等同于一次 AI 调用。本文承接 [Workflow 模型](workflow-model.md) 与 [技术职责与编译边界](runtime-architecture.md)，维护 Node 的当前边界；实现范围见 [当前架构](architecture.md#node-基础库)，阶段与下一步见 [实施方案](implementation-plan.md)。

## 统一原则

```text
React Flow Node（编辑视图）
    ↓
NodeDefinition（平台 DSL）
    ↓
NodeRegistry → NodeCompiler + CompileContext（平台适配）
    ↓
LangGraph Node Function → StateGraph.compile() → LangGraph 执行
    ↓
WorkflowRun / NodeRun（未来的业务记录投影）
```

平台 Compiler 把关系与契约映射到 LangGraph；LangGraph 负责图执行。编译生成的节点函数可接收 State，适配层按 Binding 取出明确输入，内部值操作只收到自身 inputs / config 及 LangChain RunnableConfig，不自动取得完整图、其他节点结果或聊天。Definition 与 Run 分离；类型与 Preset 分层。没有平台自建的 ready 轮询、暂停状态机或调度循环。

## 四个不同的对象

| 对象                 | 职责                                | 当前代码边界                                                                       |
| -------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `NodeDefinition`     | 一个工作流内的静态节点实例          | 保存 id、type、name、inputs、config，以及可选 preset、position                     |
| `NodeTypeDefinition` | 执行侧有效的输入、输出、配置契约    | 显式提供三个 Zod 对象 Schema；type 标识 Runtime 类型，可选 preset 标识所选有效契约 |
| `NodePreset`         | 为某类 Runtime 节点提供场景配置     | 保存 id、type、name、description 和 config；不包含执行器                           |
| `NodeRun`            | 某次 WorkflowRun 中该节点的执行记录 | 保存输入、输出、结构化错误、时间与八种基础状态，不混入静态配置                     |

NodeDefinition 的 `config` 在序列化边界只接受 JSON 记录，随后必须通过所选类型的 `configSchema` 校验；不是把任意配置交给执行器。`position` 是编辑信息，不影响激活或节点业务语义。

当前 `NodeTypeDefinition` 持有执行侧 Zod 实例，不是浏览器 JSON 协议。输入输出对象的顶层字段声明端口；字段结构、可选性、约束与配置验证复用成熟 Schema 能力。前端安全声明、完整 DataType 和端口展示适配在相应步骤补齐，不把服务端执行器或 Schema 实例直接传给浏览器。

## InputBinding 与多上游

当前来源明确表示一个上游节点的输出键：

```ts
{
  target: 'characters',
  source: { nodeId: 'characters', outputKey: 'items' }
}
```

来源键统一使用既有 Workflow 输出协议的 `outputKey`，不同时保留 `output` 别名。一个节点可以分别把 script、characters、style 绑定到多个上游，不接收“全部上游数据”。同一 target 不接受重复绑定；多结果收集或集合值必须以明确的数组 / 对象契约表达，不能靠覆盖顺序或自动拼接猜测。

实例校验检查 target 是否属于有效输入契约；实际调用前检查已组装的输入值。上游引用、输出键、类型兼容及绑定解析在数据流模型中细化；执行依赖与汇合要编译到 LangGraph 的边、条件路由和 fan-in，不另写平台就绪判定器。缺少必填值时校验失败，不轮询上游或隐式查询其他节点补齐。

工作流输入、字面量、资产引用和子流程结果如何统一为来源，留到数据流步骤确定；本步不预设表达式语言或自动收集上下文。

## Edge 与绑定的关系

第一版 Edge 按完整端口映射保存：

```ts
{
  id: 'edge-script-storyboard',
  sourceNodeId: 'script',
  sourceHandle: 'text',
  targetNodeId: 'storyboard',
  targetHandle: 'script'
}
```

同一条可视化连线可以表达执行关系并携带数据映射，不要求现在拆成两套物理边结构。但两个职责仍要区分：执行关系决定是否激活，InputBinding 决定取哪个值。数据已经具备不意味着条件分支已经被选中，未选中分支仍须传播 `skipped`。

`inputBindingFromEdge` 已提供从连线提取数据映射的纯转换，不激活目标节点。Edge 和 Node.inputs 的编辑权威来源、派生与一致性检查在数据流步骤统一确定，不能长期维护两套可独立冲突的映射。Edge Compiler 负责将已校验语义转换成 LangGraph 路由，当前尚未实现完整 DSL 图编译。

## NodeCompiler 是扩展边界

```ts
interface NodeCompiler<State extends object, Update extends object> {
  readonly type: string;
  readonly preset?: string;
  compile(
    definition: NodeDefinition,
    context: CompileContext<State, Update>,
  ): LangGraphNode<State, Update>;
}
```

实际接口在 `packages/workflow/src/compiler.ts`。State / Update 是泛型，不提前规定平台 State 容器。`LangGraphNode` 复用官方 `LangGraphRunnableConfig` 与 `GraphNodeReturnValue`，产物可直接加入真实 StateGraph，也允许原生 Command；不另建 NodeExecutionResult 或成功 / 暂停包装协议。

`NodeRegistry` 只注册显式受信任编译器，按 type / preset 精确匹配，拒绝重复注册或不可用类型，不自动退回基础类型。`CompileContext.readInputs` 与 `writeOutputs` 只负责数据绑定及 State 增量适配，不决定节点何时执行。

`createOperationNodeCompiler` 已为普通值操作提供编译适配：编译时校验实例并捕获独立配置；LangGraph 调用产物时读取输入，使用 `invokeNodeOperation` 校验输入 / 配置、调用操作、校验输出，再返回 State 增量。RunnableConfig 单独传给内部 LangChain 调用，不混入 NodeDefinition.config。

Definition 与 Preset 保留原始 JSON 配置，校验时不把 Schema 的转换或默认值回写到定义。实际操作从这份配置解析有效值，避免 Preset 应用、编译和运行之间累积转换；配置不能依靠有副作用的 Schema 转换来调用外部能力。

`invokeNodeOperation` / `NodeOperation` 是 Compiler 内部可复用的值校验工具，不是平台节点扩展或 Workflow 执行入口。它们只接受明确值，拒绝额外图状态、未声明字段和非 JSON 值，保留对象级约束。

输入和结果与调用方对象隔离，操作修改局部值不能污染外部运行数据。异常直接传播，输出不合约时拒绝作为成功结果返回；不会自动重试、替换插件或寻找替代结果。LangGraph 的 Interrupt 异常也必须传播，不能转成普通 failed 记录。

审核、条件和子图等编译器可以直接生成使用 LangGraph interrupt / Command 的节点，不强制经过普通值操作包装。图调度、Checkpoint、Interrupt、Resume、Send 和条件路由均使用 LangGraph；平台只提供 DSL 编译、契约与业务服务适配。完整 State / Binding、整图 Compiler、生产节点及持久化 Checkpointer 尚未接入。

## Runtime 类型与 Preset

故事、剧本、广告文案、角色设定、分镜描述和口播稿可能复用同一个 LLM Runtime 类型，通过 Prompt、输入输出约束和配置表达差异，不为每个文案场景创建新执行器。

`NodeTypeDefinition` 表示选定类型或 Preset 后的有效契约。相同 type 可以为不同 preset 提供不同输入输出 Schema，并复用同一执行机制；实例的 type / preset 必须与该有效契约匹配，不能找不到 Preset 时静默退回基础类型。

`applyNodePreset` 显式合并所选 Preset 配置与实例覆盖，再校验有效配置和目标端口。它不修改原对象、不自动执行、不选择厂商或凭证，也不是前端自动应用建议的授权。当前序列化 Preset 仅保存元数据与配置，有效 Schema 由调用方显式提供；NodeRegistry 已提供静态精确查找，但没有生产编译器 / Preset 目录或动态安装机制。

发布版本必须固定有效配置与输入输出契约，或绑定相应的不可变契约版本，不能运行时只按可变 Preset id 重新解析最新版。具体契约快照 / 版本引用协议随发布及数据模型补齐；现有内存快照函数不替代这一发布校验。

## NodeRun 与执行状态

基础状态为 `pending`、`ready`、`running`、`waiting`、`completed`、`failed`、`skipped`、`cancelled`。它们是未来基于 LangGraph 执行事实生成的业务投影，不是驱动另一套调度器的状态。不能由平台看到 ready 就自行派发，或把 waiting 当作自建 suspended 标志。

当前 Schema 只校验记录结构，输入输出为 JSON 记录，错误采用明确的 code / message，时间采用 ISO 字符串。运行投影、归属校验和持久化尚未实现。人工介入使用 LangGraph interrupt 与 Command.resume；根 WorkflowRun.id 绑定 thread_id，恢复仍须加载原不可变版本。中断恢复会从节点函数开头重跑，生成副作用与审核必须分开，详见 [技术职责](runtime-architecture.md)。

## 视频领域能力与厂商边界

允许 Node、Tool、Schema 和 Asset Type 与视频生产领域强相关，无需把所有能力压成万能节点。

| 层次           | 例子                                                   | 边界                                                                          |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 场景业务层     | 分镜生成、漫剧镜头生成、广告视频生成                   | 以业务模板、Preset 或确有独立语义的领域节点组合生产过程                       |
| 视频领域能力层 | ImageToVideo、TextToVideo、VideoCompose、TTS、Subtitle | 保留专业输入输出契约，不绑定单一厂商；是否独立成为 Runtime 类型按执行语义决定 |
| 基础设施层     | LLM、HTTP、Code、Storage、Queue                        | 提供基础机制，不定义漫剧或广告流程，也不能让 Queue 替代 LangGraph 调度        |

例如图生视频需要 ImageToVideo Capability，供应商通过用户明确配置的 Plugin 适配。抽帧、拼接、裁剪、音频混合等 Tool 可以专业化；模型生成仍遵守插件、模型和凭证显式选择的边界。

Start、End、LLM、Tool、Agent、Code、HTTP、If、Switch、Iteration、Batch、Join、HumanReview、SubWorkflow、Asset、Plugin 只是待评估候选，不是已确认的固定枚举或可用节点目录。Tool / Plugin / LLM / HTTP 的分类继续按后续职责设计判断；Iteration 仅考虑明确集合处理，不授权任意循环或递归。

目标是：**底层 Runtime 通用，视频领域 Capability 专业化，上层业务模板场景化。**

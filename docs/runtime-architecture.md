# Runtime 架构与技术分工

LangGraph.js 是 DramaFlow 的核心 Graph Runtime。平台围绕它实现面向视频内容生产的定义协议、编译适配、权限与业务记录，不再建立另一套图调度器。本文维护技术分工与运行边界；领域模型分别见 [Workflow 模型](workflow-model.md) 和 [Node 模型](node-model.md)，当前实施状态统一见 [实施方案](implementation-plan.md)。

## 技术职责

| 技术                   | 平台职责                                                                  | 约束                                                                     |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| React Flow             | Workflow 可视化编辑器                                                     | 节点、连线和视口属于编辑适配；其类型不进入平台 contracts                 |
| LangGraph.js           | 图执行、State 更新、Checkpoint、Interrupt / Resume、Send、条件路由        | 作为核心 Runtime，不再叠加自研图调度或 ready 轮询                        |
| LangChain.js           | Model、Tool、Agent、Message、Runnable 等抽象                              | AI 节点内部优先复用；受信任 Plugin 提供用户明确选择的外部能力            |
| Zod                    | Node Input / Output / Config 与协议边界校验                               | 可执行 Schema 留在服务端；可保存的协议不得包含函数或实例                 |
| NestJS                 | API、身份、权限、项目、运行与资产等业务服务                               | 负责业务入口与服务协作，不替代 Graph Runtime                             |
| PostgreSQL             | Workflow 定义、版本、Run、资产元数据等持久化，以及未来的持久 checkpointer | 业务定义与运行记录分离；checkpointer 的状态快照不替代 WorkflowDefinition |
| Redis / Queue / Worker | 长异步作业、跨运行 / 进程的并发与供应商配额控制、限流及唤醒               | 不决定图中下一个节点，不把队列状态当作图状态                             |

React Flow 的可视化数据不是运行定义；LangGraph 不承担 Workflow 定义数据库；LangChain 的模型与工具抽象不替代图引擎。对象存储继续使用 RustFS / S3，二进制素材不塞入 State，未来通过版本化资产引用关联。

## 定义到执行的编译链

```text
React Flow 编辑视图
    ↓ 前端适配
平台 WorkflowDefinition / 不可变 WorkflowVersion
    ↓ Workflow Compiler
    ├── NodeRegistry → NodeType（definition + compile）→ LangGraph 节点函数
    ├── Edge Compiler → 原生边 / 条件路由 / Send 等
    └── State Schema / Binding / 输出收集适配
    ↓
LangGraph StateGraph
    ↓ compile({ checkpointer })
CompiledGraph
    ↓ invoke / stream
LangGraph Runtime
```

Workflow Compiler 将已验证的领域 DSL 转为 LangGraph 构建器，LangGraph 的 `compile()` 生成可执行图；两者是不同层次。发布快照只冻结定义，不能隐式开始执行。平台负责权限、版本引用、联合依赖无环和输入输出契约检查，再把执行交给 LangGraph；原生图编译检查不能代替领域校验。[官方 Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) 说明了 State、节点、边与编译关系。

NodeRegistry 注册受信任的完整 NodeType，由 definition 提供 type / preset 身份，以 register / get / compile 精确匹配；NodeCompiler 只声明 compile，不重复维护类型标识。不动态执行浏览器代码，也不在类型、Preset 或插件缺失时回退。相近业务通过 Preset 与有效契约复用执行机制，Preset 不复制执行器；视频领域能力可以专业化，编译器不与单一供应商绑定。

LangGraph 节点函数需要接收图 State，编译适配层因此可以读取 State、解析绑定并返回 State 更新。普通业务操作仍只收到自己的 `inputs / config`，不知道上下游节点或整个 State。控制、审核等 NodeCompiler 可以直接使用 LangGraph 原生 `Command`、条件路由或 `interrupt()`，不强制套进普通值操作接口。

当前 `NodeType<State, Update>`、`NodeRegistry` 与 `createOperationNodeType` 为这条链提供基础接口。完整 NodeTypeDefinition 将 NodeContract 的服务端 Zod 与公开 metadata / UI 组合；`CompileContext.readInputs / writeOutputs` 是适配边界，没有预设完整 WorkflowState。`invokeNodeOperation` 只校验普通操作的输入、配置和输出，透传 LangChain runnable 配置，不负责 ready 判断、调度、暂停、恢复或重试。

浏览器读取 `createNodeTypeManifest` 输出的白名单元数据、纯数据 UI 描述与 JSON Schema，不接收完整 NodeTypeDefinition 或 compile。输入与配置 Schema 按 input 语义转换，输出按 output 语义转换；不导出全局 `.meta()`，无法表示的 Schema 明确报错。默认值必须可以公开，服务端仍执行完整 Zod 约束；manifest 不包含厂商密钥、模型或插件实例。具体声明与实现拆解见 [Node 模型](node-model.md) 与 [节点类型实施拆解](node-type-implementation.md)。

React Flow Node 的 type 是前端渲染器标识 `workflowNode`，Runtime 类型在 `data.nodeType`，布局经 `NodeDefinition.ui.position` 转换。前端适配层只转换白名单字段，不把 selected、dragging 或测量状态变成执行定义；当前转换尚未接入画布和 API。

完整 WorkflowState、并行更新 reducer、Binding 解析、控制激活与数据就绪的编译规则，以及 WorkflowDefinition 到整张 StateGraph 的转换，仍须在第 ④ 步明确。不能把当前通用接口标为已实现整图 Compiler。

## State、运行记录与 Checkpoint

State Schema 与 reducer 使用 LangGraph 原生机制承载。平台将明确每个 State 通道的领域语义、更新方式与可序列化边界，不另外维护一份驱动执行的可变状态。WorkflowRun / NodeRun 的状态用于查询、界面和审计等业务投影，不用它们重新决定节点调度。

平台根运行使用 `WorkflowRun.id` 作为 `configurable.thread_id`。`createWorkflowRunConfig` 检查 Run 与 Version 的归属并构造该配置，不创建、启动或恢复运行。未来的运行服务在每次执行与恢复前检查权限、版本及运行归属，避免把知道 thread_id 当作授权。

Checkpoint 保存 thread 的执行状态，不保存可重新部署执行的完整领域 DSL。进程重启后，平台仍须加载 Run 原来绑定的不可变 WorkflowVersion，以兼容的 NodeCompiler 和 State Schema 重新构建 / 编译图，并接回同一个持久 checkpointer 和 thread_id；不能加载当前草稿或动态选择最新版。编译实现的兼容性与版本管理待运行持久化阶段明确。

生产持久 checkpointer 尚未接入。当前真实 LangGraph 集成测试显式使用 MemorySaver 验证编译节点与原生执行行为；内存 checkpoint 随进程退出丢失，不构成生产恢复能力，也不允许成为生产存储故障时的静默兜底。持久化职责与内存限制见 [官方 Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)。

## 人工中断与恢复

人工审核编译为 LangGraph `interrupt(payload)`，恢复通过同一个根 thread 的 `new Command({ resume: value })` 进入原图。平台负责审核请求展示、权限、恢复值校验和幂等入口；暂停位置与继续执行由 LangGraph 管理。

当前依赖 `@langchain/langgraph 1.5.0` 的 Command 输入处理使用真值判断，裸 `false`、`0` 或空字符串恢复值会被忽略。集成验证使用经 Zod 校验的结构化反馈（包括 `{ approved: false }`），不把裸假值恢复标为可用；正式审核协议与依赖升级时须复核这一边界。

`interrupt()` 使用特殊控制异常暂停执行。适配层不能吞掉它、转换成普通失败结果或写为 NodeRun `failed`。恢复时整个节点函数会从开头重跑，因此生成请求、资产写入等副作用必须与审核步骤分离；确有必要重入的操作复用稳定操作标识，不因恢复自动重新生成。中断载荷与恢复值保持可序列化；细节见 [官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)。

Run 的 `waiting` 只是业务展示状态。等待供应商回调、人工确认或批处理都需要明确的等待原因与恢复入口，不能由一个平台状态字段取代 checkpoint。具体等待模型及事件持久化留待后续设计。

## 并行、队列与副作用

静态分支、条件路由、动态扇出与汇聚优先映射到 LangGraph 原生图机制；动态任务分发使用 `Send`，不建立平台任务列表反复扫描 ready 节点。Send 不等同于所有层面的容量控制。

单次图调用支持顶层 runnable 配置 `maxConcurrency`，例如 `graph.invoke(input, { maxConcurrency: 3 })`；它不放在 `configurable` 内。跨 WorkflowRun、跨进程、供应商账号配额、每秒请求限制和长时间外部异步作业需要 Queue / Worker 及专门的限流策略共同协调，不能只靠某一次图调用的并发数。[官方 Use the graph API](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api) 说明了图内并行、条件分支及 maxConcurrency。

Queue / Worker 完成作业或收到回调后唤醒对应运行，图的后续路径继续由 LangGraph 推进。具体队列协议、异步回调与运行恢复尚未实现。Middleware 可以应用日志、成本或受约束的重试，但不替代图调度。

重试策略区分安全读取与可能收费的生成副作用；外部受理状态不明时保留 `outcome_unknown`，不盲目重试。Checkpoint 恢复不承诺外部 exactly-once，用户主动重生成必须创建新的产物版本。

## 当前交付边界

基础库已有平台 Workflow / Node Schema、版本快照与值契约、完整 NodeType / NodeRegistry、普通操作适配、公开 manifest 转换及根 Run 配置映射。前端 Node / Edge 双向转换独立于画布。真实 LangGraph 测试覆盖基础编译适配与原生运行行为，测试中的节点和 MemorySaver 不作为生产类型目录或运行服务；具体实现范围统一见 [当前架构](architecture.md)。

当前 Web 仍是 React Flow 空白画布，API 不保存或执行 WorkflowDefinition。生产节点、Plugin、LangChain 模型调用、整图 Compiler、持久 checkpointer、运行接口、Queue 作业及人工审核产品流程均未接入。后续实现继续按已确认范围逐步推进，不能用基础适配测试替代这些能力的交付验证。

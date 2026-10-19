# Runtime 架构与技术分工

LangGraph.js 是 DramaFlow 的核心 Graph Runtime。平台围绕它实现面向视频内容生产的定义协议、编译适配、权限与业务记录，不再建立另一套图调度器。本文维护技术分工与运行边界；领域模型见 [Workflow](workflow-model.md)、[Node](node-model.md) 与 [WorkflowState 边界](workflow-state.md)，当前阶段统一见 [实施方案](implementation-plan.md)。

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
    ├── NodeRegistry → NodeType（manifest + Zod + compile）→ LangGraph 节点函数
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

NodeRegistry 注册受信任的服务端 NodeType，按 manifest.type / manifest.version 精确匹配，get 不寻找最新版。实例 typeVersion 必须明确，Preset 只是配置模板，不参与注册身份。NodeCompiler 只声明 compile，不重复维护类型身份，不在版本或插件缺失时回退；视频领域能力可以专业化，编译器不与单一供应商绑定。

LangGraph 节点函数需要接收图 State，编译适配层因此可以读取 State、解析绑定并返回 State 更新。普通业务操作仍只收到自己的 `inputs / config`，不知道上下游节点或整个 State。控制、审核等 NodeCompiler 可以直接使用 LangGraph 原生 `Command`、条件路由或 `interrupt()`，不强制套进普通值操作接口。

当前 NodeType 持有纯 JSON manifest、三组服务端 Zod 与 compile，createOperationNodeType 保留泛型普通操作适配。CompileContext.readInputs / writeOutputs 没有预设具体 WorkflowState，不解析四类 Binding；invokeNodeOperation 仅校验实际输入、配置和输出并透传 runnable 配置，不负责 ready 判断、调度、暂停、恢复或重试。普通节点只生成自身函数，不持有全图 builder 或增加其他节点的边。

浏览器经受保护目录 API 读取 listManifests 的纯 JSON 副本；Manifest.config 是公开字段数组，不携带 Zod、JSON Schema、compile 或服务端实例。公开默认值和声明文本不得含密钥，后端实际值仍按完整 Zod 校验。DataType 只做静态匹配：目标端口为 any 时接受其他类型，any 来源不能接到具体端口。capabilities 不提供 Resolver；具体边界见 [Node 模型](node-model.md) 与 [Manifest 实施说明](node-type-implementation.md)。

React Flow renderer 使用 workflowNode，领域类型与版本在 data.nodeType / data.typeVersion，布局对应必填 ui.position。数据边从 Node.inputs.connection 派生，Workflow.edges 只保存控制关系；临时交互状态不进入 DSL。画布已注册 GenericWorkflowNode 并查询目录，尚无图编辑保存。输入控件提示在 ui.inputs，配置控件提示只在 config[].ui，不承担 Binding 运行求值。

正式 WorkflowDefinition 已校验静态引用与联合 DAG；WorkflowState 已确定最小分区、当前输出与历史分离方向，尚无最终值协议或 State Schema。先确定 DataType / RuntimeValue / Reference / Domain Object，再完成 State、Binding Resolver 和整图 Compiler，不能用泛型接口代替这些模型。

## State、运行记录与 Checkpoint

State 的 run / inputs 不可变、outputs 只保留当前有效值、variables 显式与 execution 最小化，以及 State / 业务记录 / 内容存储的职责，集中维护在 [WorkflowState 边界](workflow-state.md)。各通道最终值类型、reducer、同节点并发冲突与分支身份尚未落地，Run / NodeRun 状态不驱动第二套调度器。

WorkflowRun 元数据有独立必填 threadId，createWorkflowRunConfig 校验 Run / Version 后将 run.threadId 写入 configurable.thread_id，拒绝冲突配置，不要求 threadId 等于 Run.id。该函数不创建线程或运行，不检查项目权限或执行恢复；未来运行服务必须验证归属，不能把知道 thread_id 当作授权。

Checkpoint 保存执行快照，不保存可重新部署的完整领域 DSL。恢复仍须加载 Run 原来绑定的不可变 WorkflowVersion，以兼容的编译实现重新构建图，接回同一 threadId 和持久 checkpointer。NodeRun 的 attempt 与可选 JSON 快照仅实现契约，不代表已有业务 Store、attempt 分配或运行投影一致性。

生产持久 checkpointer 尚未接入。原生集成测试显式使用 MemorySaver，内存快照随进程退出丢失，不构成生产恢复，也不能成为存储故障时的静默兜底。[官方 Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 说明原生持久化职责。

## 人工中断与恢复

人工审核编译为 LangGraph interrupt(payload)，恢复通过 Run 原有 threadId 与 new Command({ resume: value }) 进入原图。平台负责审核请求展示、权限、恢复值校验和幂等入口；暂停位置与继续执行由 LangGraph 管理。

当前依赖 `@langchain/langgraph 1.5.0` 的 Command 输入处理使用真值判断，裸 `false`、`0` 或空字符串恢复值会被忽略。集成验证使用经 Zod 校验的结构化反馈（包括 `{ approved: false }`），不把裸假值恢复标为可用；正式审核协议与依赖升级时须复核这一边界。

`interrupt()` 使用特殊控制异常暂停执行。适配层不能吞掉它、转换成普通失败结果或写为 NodeRun `failed`。恢复时整个节点函数会从开头重跑，因此生成请求、资产写入等副作用必须与审核步骤分离；确有必要重入的操作复用稳定操作标识，不因恢复自动重新生成。中断载荷与恢复值保持可序列化；细节见 [官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)。

Run 的 `waiting` 只是业务展示状态。等待供应商回调、人工确认或批处理都需要明确的等待原因与恢复入口，不能由一个平台状态字段取代 checkpoint。审核决策等业务审计独立于 checkpoint，具体等待模型与持久化仍待设计，见 [State、Thread 与审计边界](workflow-state.md#thread人工介入与审计)。

## 并行、队列与副作用

静态分支、条件路由、动态扇出与汇聚优先映射到 LangGraph 原生图机制；动态任务分发使用 `Send`，不建立平台任务列表反复扫描 ready 节点。Send 不等同于所有层面的容量控制。

单次图调用支持顶层 runnable 配置 `maxConcurrency`，例如 `graph.invoke(input, { maxConcurrency: 3 })`；它不放在 `configurable` 内。跨 WorkflowRun、跨进程、供应商账号配额、每秒请求限制和长时间外部异步作业需要 Queue / Worker 及专门的限流策略共同协调，不能只靠某一次图调用的并发数。[官方 Use the graph API](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api) 说明了图内并行、条件分支及 maxConcurrency。

Queue / Worker 完成作业或收到回调后唤醒对应运行，图的后续路径继续由 LangGraph 推进。具体队列协议、异步回调与运行恢复尚未实现。Middleware 可以应用日志、成本或受约束的重试，但不替代图调度。

重试策略区分安全读取与可能收费的生成副作用；外部受理状态不明时保留 `outcome_unknown`，不盲目重试。Checkpoint 恢复不承诺外部 exactly-once，用户主动重生成必须创建新的产物版本。

## 当前交付边界

基础库已有纯 JSON Manifest、四类 Binding、ControlEdge、静态引用及联合 DAG 校验、NodeType / Registry、版本快照和普通操作适配。目录 API 与通用 renderer 已接入，生产 Registry 为空。真实 LangGraph 测试保留泛型适配与原生运行验证，测试类型和 MemorySaver 不作为生产能力；具体范围统一见 [当前架构](architecture.md)。

当前项目仍只保存名称、视口和 revision。独立 threadId、NodeRun attempt 与可选快照只落到契约；完整 WorkflowState / RuntimeValue、Binding 求值、Run / NodeRun 数据库、整图 Compiler、持久 checkpointer、运行接口、真实生成和审核业务均未接入。

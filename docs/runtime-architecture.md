# Runtime 架构与技术分工

LangGraph 是核心图 Runtime。平台实现定义协议、编译适配、业务执行和记录，不自建图调度、Checkpoint 或恢复状态机。数据与 Node 模型见 [数据模型](data-model.md)、[Node](node-model.md) 和 [State](workflow-state.md)，当前能力见 [架构](architecture.md)。

## 技术边界

React Flow 负责编辑器与交互，平台定义经适配保存；contracts 不依赖 React Flow、NestJS、Prisma 或 LangGraph。LangChain 提供模型 / Tool / Agent 等节点内部抽象。Zod 验证协议和实际值，可执行 Schema 留在服务端。

NestJS 承担认证、权限与业务入口；PostgreSQL 保存业务记录并承接未来持久 checkpointer；RustFS / S3 保存内容。Redis / Worker 后续承担长任务、配额与唤醒，不决定图中下一个节点。

## 编译与执行分离

```text
WorkflowDefinition / Version
  → WorkflowCompiler
  → NodeCompilationStrategy
  → LangGraph Node Function
  → NodeExecutor
  → BindingResolver + RuntimeValueCodec + NodeRun / 内容服务
  → NodeType.execute(input, config, context)
```

普通 NodeType 不再 compile，也不取得 Graph builder。ActionNodeCompilationStrategy 仅注册调用统一 Executor 的函数，不为每个 LLM、TTS 或视频业务复制编译策略。control / composite / interaction 具有不同图语义，后续由相应结构策略处理，不强行套普通 action。

NodeExecutor 负责输入绑定与 decode、完整 Zod 校验、业务调用、输出校验与 encode、Artifact 持久化、NodeRun 和自身 State 更新。普通节点不解析资产、写其他节点结果或自行判断 ready。Codec / Resolver / Executor / Store 当前只有服务接口，完整生产执行链未接入。

原有 invokeNodeOperation 是独立值校验工具，不是第二套 Runtime。测试中直接使用原生 StateGraph / MemorySaver 只验证适配与线程机制，不能作为生产持久化或真实生成能力。

## State 与持久化

WorkflowState.outputs 使用 RuntimeValue map，定义、业务历史、内容存储与执行快照分离。真正的通道和 reducer 随 Graph Model 明确，不能用对象覆盖或业务状态轮询代替。[官方 Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) 说明图和状态机制。

运行配置使用必填 Run.threadId；恢复必须加载原不可变 WorkflowVersion，以兼容实现重建图，接回原 thread 与持久 checkpointer，而不是当前草稿。知道 thread_id 不等于拥有资源权限。当前只实现配置映射，没有生产运行接口和持久 checkpointer。[官方 Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 说明原生持久化机制。

## 人工介入、并行与副作用

人工介入继续使用 interrupt / Command.resume，不能吞掉中断控制异常或把它记为普通失败；恢复可能使节点从开头重入。审核决策是独立业务审计，waiting 仅业务投影；生成副作用与审核分离，受理结果不明不盲目重试，不承诺外部 exactly-once。[官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 描述原生规则。

静态分支、条件、Send、fan-in 与子图使用 LangGraph 机制，精确映射待下一步 Graph Model。单次图调用 maxConcurrency 位于顶层配置；跨运行与供应商配额由后续 Queue / Worker 处理，不把 Send 当作全部容量控制。[官方 Graph API 示例](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api) 展示这些执行机制。

当前没有结构策略、完整 Compiler、生产 Runtime、模型调用、Queue、审核或内容 Store。生产节点目录仍为空；不得将测试适配、类型接口或规划标为可用业务能力。

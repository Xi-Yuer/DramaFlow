# Runtime 架构与技术分工

平台负责领域协议、编译适配和业务记录；LangGraph 负责调度、State 通道、checkpoint、interrupt / resume。定义见 [Workflow](workflow-model.md)，业务类型见 [Node](node-model.md)，值与内容见[数据模型](data-model.md)，实际装配见[架构](architecture.md)。

## 技术边界

React Flow 只负责编辑。受信任文本 Capability 在插件内部使用 Vercel AI SDK，旧兼容插件保留 LangChain；Tool / Agent 等抽象按实际需要使用 LangChain。SDK 对象不是领域身份，contracts 不依赖这些框架，不自建第二套调度或恢复机制。

## 编译与执行分离

```text
WorkflowDefinition → WorkflowCompiler → LangGraph StateGraph
Action wrapper → NodeExecutor → RuntimeValue 输出 → State reducer
```

Compiler 冻结定义，按 Registry / executionKind 选择策略，连接 START / END 及依赖边；不创建 Run / thread、记录状态或执行业务。空图可直接结束，普通 Action 不自行 compile。

Executor 的顺序固定为 createRunning → 精确版本 / Binding → 记录 RuntimeValue 输入 → decode → input / config Schema → execute → output Schema → encode → markCompleted。完成记录成功才返回输出，不直接修改 State；Codec / Writer 接收最小项目、运行、节点 / 输出定位，不取得整个 State。

### Action 执行错误阶段

业务异常记录 resolve_input、decode_input、validate_input、validate_config、execute、validate_output 或 encode_output；编码 / 写入失败与输出校验失败分开。NodeExecutionError 可保留原始 cause，但持久 NodeRunError 只投影安全阶段摘要，不保存 cause / stack / Provider 内容。

Repository 故障是基础设施错误；完成记录失败不能反向 markFailed 或产生 State 输出，双重记录失败保留两种原因。GraphBubbleUp（含 interrupt / 父图 Command）原样交回 LangGraph，不包装为业务失败，已有 NodeRun 保持 running。普通失败停止后续步骤，不自动重试。

### 普通确定性依赖的 ALL Join

Data / Control Edge 都产生确定性执行依赖。collectNodeDependencies 只读 nodeId，按 target 聚合、source 去重，同一节点对的多端口 / 混合边只计一次；不读取端口或构造输入。

单上游使用 `addEdge(source, target)`，多上游必须使用一次 `addEdge([sources], target)`，等待全部完成后执行一次；不拆成独立触发边，不增加 joinMode 或 ready 计数。条件候选分支、Send / Batch 不套用静态 ALL，需独立结构策略。

### Data Edge 与节点输入

BindingResolver 按 Manifest 读取 Data Edge 的上游端口或包装静态输入。Control Edge 不提供输入值。依赖编译保持原始端口信息，取值、decode 与真实 Schema 校验依次独立。

### RuntimeValue Decode 边界

inline 无 I/O，reference 仅交给有授权作用域的 Resolver；任一引用失败则整组失败，不返回部分值。临时媒体 URL 只供业务消费，不回写持久快照，完整规则见数据模型。

### 节点业务记录与 Checkpoint

NodeRun 记录 attempt、输入输出和安全错误；Checkpoint 保存图的可恢复状态，不能相互推导。输入在 decode 前保存，输出在 encode 后保存。业务状态和 checkpoint 不承诺跨存储原子提交，记录不一致时需要核查，不通过自动重跑掩盖。

### WorkflowRun 记录边界

Submission 只事务创建 pending Run / Outbox 或 waiting 周期的 resume 意图，不编译、不 claim。Runner 只执行已存在 Run，原子 claim 胜者才进入 Graph；Repository 每次校验当前项目 / 所有者。Run 身份、固定版本、thread 和初始输入不可改写。

### WorkflowRunner 首次启动

executeStart 先 claim pending → running，首次设置 startedAt，再加载原版本并冻结、编译；初始 State 和 thread_id 只取自持久 Run。竞争失败不执行。Graph 返回后检查 StateSnapshot.next / tasks、interrupt 及身份：有待执行任务记 waiting，结束时按 Workflow 输出声明解析 RuntimeValue 后记 completed。

claim 后准备 / 执行失败由胜者记录 failed；记录服务失败不能再反向写失败。Node 失败不作为下游占位输出。输出来源缺失或类型不符同样失败。

### WorkflowRunner 恢复

executeResume 只接受 Run ID / value，原子 claim waiting → running，保留 startedAt，再读取原版本和原 thread 的 checkpoint。缺失或身份不符明确失败，不初始化新 State、不重跑已完成节点、不创建新 Run / thread。

使用 LangGraph Command 继续原快照；单个 interrupt 的 falsy value 通过其原生 interrupt ID 映射适配，不把 null / 0 / false 当作缺参。恢复后可再次 waiting。Runner 不查询 interaction NodeRun，具体关联留待 Human Review 设计。

### 生产应用装配

API 事务提交并确认 enqueue，Worker 核验持久意图后执行。Job 不复制定义 / State / thread。claim 前基础设施故障可重投，业务失败不可重跑；claim 后结果不明记 recovery_required，已有业务终态只补记意图。持久去重不依赖 Redis Job 一直存在，详见[架构](architecture.md#workflow-execution-queue)。

### 文本 Capability 调用边界

Node 只引用 modelConfigurationId；server 负责当前 Run / 项目授权、配置读取与解密，PluginRegistry 负责统一校验和安全错误投影，ProviderCapability 内部调用 SDK。客户端只按 invocation 创建。当前实现、参数、retry / redirect 与日志边界集中在[文本能力](architecture.md#文本-ai-与-provider-plugin)。

### Run HTTP 边界

用户身份来自 Actor，版本反查资源归属，拒绝客户端声明 thread / 状态 / 项目身份。start / resume 返回 202；GET 公开安全业务 DTO；404 隐藏资源是否存在，非 waiting 为 409。入队未确认时安全 503 仍可能已经提交意图，不能盲目重提；HTTP 断开不会取消执行，也没有 fire-and-forget 兜底。

## State 与持久化

Definition / Version 保存静态流程，Run 保存运行身份，State 保存当前必要值，NodeRun 保存历史，Artifact / Asset 保存内容，Checkpoint 保存恢复快照。State 不承载全部日志、原始媒体、数据库或模型对话历史。

### 五个分区

| 分区 | 内容与写入边界 |
| --- | --- |
| run | workflowId / workflowVersionId / workflowRunId / projectId，不可变 |
| inputs | 本次 Workflow RuntimeValue 输入，不可变 |
| outputs | nodeId → outputKey → RuntimeValue，当前有效结果 |
| variables | 显式工作流变量，不开放节点任意读写 |
| execution | 图控制状态，目前保留为空 |

State 类型与 Annotation 共处 runtime/state.ts；run / inputs / variables / execution 为单值通道，Action wrapper 只写 outputs。

### 并行与历史

wrapper 只返回 `{ outputs: { [nodeId]: result.output } }`，不展开旧 outputs。mergeNodeOutputs 非变异合并不同节点的结果；重复 nodeId 抛 DUPLICATE_NODE_OUTPUT_WRITE，即使值相同也拒绝，不合并端口片段、不静默覆盖。

这是普通 DAG 的单次有效输出约束，同时拒绝同 step 和后续 step 重写；reducer 无法凭累计状态猜测重试 / 循环 / 审核语义。历史和成本应进入独立记录，attempt 不等于函数重入次数，Send 分支不能只用 nodeId 标识。

### PostgreSQL Checkpointer

官方 PostgresSaver 使用独立 pg.Pool 与 langgraph schema，不由 Prisma 管理表或序列化。应用初始化以 advisory transaction lock 串行 setup 并 getTuple 验证读取；失败阻止就绪，关闭时 end，无 MemorySaver 生产降级。

Compiler 只接收 saver，不执行 setup；恢复依赖同一数据库 / schema、原 thread、原版本与兼容实现。thread_id 不代表访问权限，运行配置拒绝覆盖它。初始化、连接与备份见[部署](deployment.md#langgraph-postgresql-checkpointer)。

## 人工介入、并行与副作用

人工介入使用 LangGraph interrupt / Command.resume；节点可能从开头重入，审核审计独立于 checkpoint，生成副作用与审核分离。普通 Action 禁止主动 interrupt，不能用业务状态轮询另建恢复状态机，不承诺外部 exactly-once。

Send 使用 branch-local 输入；SubWorkflow 通过显式输入输出映射组合，不复制父 State。图级 maxConcurrency、Worker 跨运行并发及供应商配额属于不同边界。控制 / interaction、Batch / SubWorkflow 的产品实现仍待单独任务，不把测试中断图当作已交付能力。

官方机制参考：[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)、[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)、[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)。本项目适配细节以安装包和代码为准。

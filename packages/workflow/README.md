# @dramaflow/workflow

提供领域无关的 Workflow / Node 契约、快照、操作校验及 LangGraph 节点编译适配。完整 State / Binding、整图 DSL Compiler、生产节点、插件调用和持久化运行服务尚未接入。

| 导出                            | 行为                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `parseWorkflowInputs`           | 使用调用方提供的 Zod 值契约校验输入，拒绝未声明字段和非 JSON 值      |
| `collectWorkflowOutputs`        | 根据显式来源收集并校验最终输出，拒绝缺失来源、继承属性或类型不符     |
| `createWorkflowVersionSnapshot` | 使用调用方提供的完整版本 Schema 校验、复制并递归冻结 JSON 快照       |
| `assertWorkflowRunVersion`      | 校验运行的版本身份及 Workflow 身份是否一致                           |
| `parseNodeDefinition`           | 校验实例与有效类型 / Preset 契约匹配、绑定目标端口及配置             |
| `applyNodePreset`               | 显式合并 Preset 配置与实例覆盖，再通过有效契约校验                   |
| `inputBindingFromEdge`          | 提取连线的输入绑定投影，不激活节点                                   |
| `invokeNodeOperation`           | 输入与配置校验 → 显式操作 → 输出校验，透传 runnable 配置，不自动重试 |
| `NodeRegistry`                  | 按 type / preset 精确选择显式注册的编译器，拒绝重复及不可用类型      |
| `createOperationNodeCompiler`   | 将普通值操作适配为可直接加入 LangGraph StateGraph 的节点函数         |
| `createWorkflowRunConfig`       | 校验 Run / Version 身份并绑定根 Run.id 为 thread_id，保留其他配置    |

`WorkflowInputContract` / `WorkflowOutputContract` 是执行侧已编译值契约，持有具体 Zod Schema，不作为浏览器 JSON 协议传输。可选与默认行为只来自显式 Schema；DataType 到值校验器的映射仍待数据模型确定。

`NodeTypeDefinition` 包含 type、可选 preset 及 inputSchema / outputSchema / configSchema。相同 Runtime type 可使用不同有效 Preset 契约并复用执行机制，不把每个业务名变成新执行器。`NodeOperation` 的业务参数只含 inputs / config，另收 LangChain RunnableConfig，返回值由输出 Schema 校验。Definition / Preset 保存原始 JSON 配置，校验时不回写 Schema 的转换或默认值，防止后续调用再次解析时累积转换。

`NodeCompiler<State, Update>` 是节点扩展接口，生成使用官方 LangGraph 配置及返回值协议的函数，支持原生 Command / interrupt。`CompileContext.readInputs / writeOutputs` 将 State 与普通操作的输入输出隔离，不预设完整 WorkflowState。普通操作工厂编译时验证并捕获独立配置，运行时从 State 读取输入并返回增量；控制与审核编译器可直接使用 LangGraph 原生机制。

`NodeContractError` 区分有效契约不匹配、未知目标端口和 Preset 不匹配；`NodeCompilationError` 区分重复注册和编译器不可用。没有类型或 Preset 回退。普通操作校验拒绝未声明字段和非 JSON 值，保留对象级约束并隔离可变对象；不解析绑定、不更新 NodeRun、不处理激活或图调度，控制异常直接交还 LangGraph。

`WorkflowContractError` 区分重复契约名、缺失来源节点、缺失来源键与版本不匹配；字段或值类型错误保留 Zod 校验信息。输出只包含声明的名称，不从最后完成的节点推断。结果来源键只读取自有属性。

快照函数保证内存对象的隔离与只读，不写数据库，也不替代权限、完整图校验或发布并发控制。Run 配置映射不检查项目权限、加载版本或创建任务。真实 LangGraph 测试验证编译适配、Interrupt / Command 恢复、Send / reducer 和图内并发；测试中的 MemorySaver 不代表生产恢复能力。

模型见 [Workflow 模型](../../docs/workflow-model.md) 与 [Node 模型](../../docs/node-model.md)，技术分工见 [Runtime 架构](../../docs/runtime-architecture.md)，实施范围见 [当前架构](../../docs/architecture.md)，当前阶段与下一步见 [分步设计与实施方案](../../docs/implementation-plan.md)。

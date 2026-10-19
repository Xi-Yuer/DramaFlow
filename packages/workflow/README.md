# @dramaflow/workflow

提供领域无关的 Workflow / Node 基础库，当前没有生产 Node 执行器目录、完整图校验、LangGraph 调度适配、插件调用或持久化发布服务。

| 导出                            | 行为                                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| `parseWorkflowInputs`           | 使用调用方提供的 Zod 值契约校验输入，拒绝未声明字段和非 JSON 值  |
| `collectWorkflowOutputs`        | 根据显式来源收集并校验最终输出，拒绝缺失来源、继承属性或类型不符 |
| `createWorkflowVersionSnapshot` | 使用调用方提供的完整版本 Schema 校验、复制并递归冻结 JSON 快照   |
| `assertWorkflowRunVersion`      | 校验运行的版本身份及 Workflow 身份是否一致                       |
| `parseNodeDefinition`           | 校验实例与有效类型 / Preset 契约匹配、绑定目标端口及配置         |
| `applyNodePreset`               | 显式合并 Preset 配置与实例覆盖，再通过有效契约校验               |
| `inputBindingFromEdge`          | 提取连线的输入绑定投影，不激活节点                               |
| `executeNode`                   | 输入与配置校验 → 显式执行函数 → 输出校验，不自动重试             |

`WorkflowInputContract` / `WorkflowOutputContract` 是执行侧已编译值契约，持有具体 Zod Schema，不作为浏览器 JSON 协议传输。可选与默认行为只来自显式 Schema；DataType 到值校验器的映射仍待数据模型确定。

`NodeTypeDefinition` 包含 type、可选 preset 及 inputSchema / outputSchema / configSchema。相同 Runtime type 可使用不同有效 Preset 契约并复用执行机制，不把每个业务名变成新执行器。`NodeExecutor` 只接收 inputs / config，返回值由输出 Schema 校验；有效契约必须由调用方明确提供，没有生产目录或隐藏默认类型。

`NodeContractError` 区分有效契约不匹配、未知目标端口和 Preset 不匹配。调用边界拒绝未声明字段和非 JSON 值，保留对象级约束并隔离可变对象；不解析绑定、不传 State、不更新 NodeRun，也不自动处理激活、恢复或图调度。

`WorkflowContractError` 区分重复契约名、缺失来源节点、缺失来源键与版本不匹配；字段或值类型错误保留 Zod 校验信息。输出只包含声明的名称，不从最后完成的节点推断。结果来源键只读取自有属性。

快照函数保证内存对象的隔离与只读，不写数据库，也不替代权限、完整图校验或发布并发控制。运行版本检查接收已通过基础 Schema 校验的元数据，不检查项目权限或创建任务；这些职责留在应用服务。LangGraph 依赖不代表已经实现调度。

模型见 [Workflow 模型](../../docs/workflow-model.md) 与 [Node 模型](../../docs/node-model.md)，实施范围见 [当前架构](../../docs/architecture.md)，当前阶段与下一步见 [分步设计与实施方案](../../docs/implementation-plan.md)。

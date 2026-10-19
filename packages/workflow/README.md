# @dramaflow/workflow

提供领域无关的 Workflow 基础库，当前没有 Node 执行器、完整图校验、LangGraph 调度适配、插件调用或持久化发布服务。

| 导出                            | 行为                                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| `parseWorkflowInputs`           | 使用调用方提供的 Zod 值契约校验输入，拒绝未声明字段和非 JSON 值  |
| `collectWorkflowOutputs`        | 根据显式来源收集并校验最终输出，拒绝缺失来源、继承属性或类型不符 |
| `createWorkflowVersionSnapshot` | 使用调用方提供的完整版本 Schema 校验、复制并递归冻结 JSON 快照   |
| `assertWorkflowRunVersion`      | 校验运行的版本身份及 Workflow 身份是否一致                       |

`WorkflowInputContract` / `WorkflowOutputContract` 是执行侧已编译值契约，持有具体 Zod Schema，不作为浏览器 JSON 协议传输。可选与默认行为只来自显式 Schema；DataType 到值校验器的映射仍待数据模型确定。

`WorkflowContractError` 区分重复契约名、缺失来源节点、缺失来源键与版本不匹配；字段或值类型错误保留 Zod 校验信息。输出只包含声明的名称，不从最后完成的节点推断。结果来源键只读取自有属性。

快照函数保证内存对象的隔离与只读，不写数据库，也不替代权限、完整图校验或发布并发控制。运行版本检查接收已通过基础 Schema 校验的元数据，不检查项目权限或创建任务；这些职责留在应用服务。LangGraph 依赖不代表已经实现调度。

模型见 [Workflow 模型](../../docs/workflow-model.md)，实施范围见 [当前架构](../../docs/architecture.md#workflow-基础库)，当前阶段与下一步见 [分步设计与实施方案](../../docs/implementation-plan.md)。

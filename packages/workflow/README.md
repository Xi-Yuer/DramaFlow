# @dramaflow/workflow

服务端数据与节点基础库：

| 目录       | 职责                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| definition | 显式输入输出值校验、版本快照与运行版本归属                                                                                   |
| data       | DataTypeDefinition / Registry，递归真实值 Zod 校验                                                                           |
| node       | NodeType.execute、精确版本 Registry、值 Schema 与 Preset 校验                                                                |
| runtime    | WorkflowState Annotation / outputs reducer、输入组装、Codec 与 Action 输出编码，引用 / Artifact 服务接口与 NodeRunRepository |
| compiler   | CompilationStrategy、薄 action 包装、Data / Control Edge 依赖收集与 ALL Join 编译                                            |
| run        | 显式 Run.threadId 到 LangGraph 配置的映射                                                                                    |

NodeType 不再自行 compile，普通业务只处理 input + config + context。NodeRegistry 的非 action 声明由独立结构策略处理，不伪装普通操作。createOperationNodeType 仅组合业务实现；invokeNodeOperation 保留独立真实值校验，不承担调度、Binding 或持久化。

DataTypeRegistry 的公开副本不含 Zod。isTypeAssignable 重导出共享纯函数，前后端采用相同规则。RuntimeValue 包含实际类型与承载方式，NodeOutputMap 不使用 unknown 代替结果。

BindingResolver 按 Manifest 组装 RuntimeValue，Decode 只返回 inline 值或委托引用服务。Action NodeExecutor 先创建 NodeRun，再串联精确 Registry、绑定、记录 RuntimeValue 输入、decode、三组 Schema、业务调用、逐端口 encode 和完成记录，返回 RuntimeValue map，编译包装只返回当前节点的 outputs 增量，由既有 State 模块的 reducer 合并，重复 nodeId 写入明确失败。auto 通过统一类型规则选择 inline / reference，引用输出仅经注入的 ArtifactWriter 写入。NodeRunRepository 强制注入，由 API 的 PostgreSQL 实现原子分配 attempt 并保存历史；引用解析、Artifact 写入与内容服务尚无生产实现，不提供内存、本地文件或默认模型兜底。尚无完整图运行接口或生产持久 checkpointer；MemorySaver 和测试实现不作为生产能力。

详细说明见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md)、[Runtime](../../docs/runtime-architecture.md)、[当前架构](../../docs/architecture.md) 与 [实施方案](../../docs/implementation-plan.md)。

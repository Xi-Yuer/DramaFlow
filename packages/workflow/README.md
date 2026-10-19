# @dramaflow/workflow

服务端数据与节点基础库：

| 目录       | 职责                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| definition | 显式输入输出值校验、版本快照与运行版本归属                                                    |
| data       | DataTypeDefinition / Registry，递归真实值 Zod 校验                                            |
| node       | NodeType.execute、精确版本 Registry、值 Schema 与 Preset 校验                                 |
| runtime    | typed WorkflowState 与 Codec / BindingResolver / Executor / 内容 Store / NodeRunRecorder 接口 |
| compiler   | CompilationStrategy 接口与薄 action 包装，不含完整整图编译                                    |
| run        | 显式 Run.threadId 到 LangGraph 配置的映射                                                     |

NodeType 不再自行 compile，普通业务只处理 input + config + context。NodeRegistry 的非 action 声明由独立结构策略处理，不伪装普通操作。createOperationNodeType 仅组合业务实现；invokeNodeOperation 保留独立真实值校验，不承担调度、Binding 或持久化。

DataTypeRegistry 的公开副本不含 Zod。isTypeAssignable 重导出共享纯函数，前后端采用相同规则。RuntimeValue 包含实际类型与承载方式，NodeOutputMap 不使用 unknown 代替结果。

Codec、Resolver、Executor 与内容 / 审计服务尚无生产实现；没有内存、本地文件或默认模型兜底。State 无生产 reducer、图运行接口或持久 checkpointer；MemorySaver 和测试实现不作为生产能力。

详细说明见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md)、[Runtime](../../docs/runtime-architecture.md)、[当前架构](../../docs/architecture.md) 与 [实施方案](../../docs/implementation-plan.md)。

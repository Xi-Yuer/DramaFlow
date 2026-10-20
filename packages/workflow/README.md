# @dramaflow/workflow

服务端数据与节点基础库：

| 目录       | 职责                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| definition | 显式输入输出值校验、版本快照与运行版本归属                                        |
| data       | DataTypeDefinition / Registry，递归真实值 Zod 校验                                |
| node       | NodeType.execute、精确版本 Registry、值 Schema 与 Preset 校验                     |
| runtime    | WorkflowState、输入组装、Decode 与 Action 主干，引用解析 / 编码 / 内容与审计接口  |
| compiler   | CompilationStrategy、薄 action 包装、Data / Control Edge 依赖收集与 ALL Join 编译 |
| run        | 显式 Run.threadId 到 LangGraph 配置的映射                                         |

NodeType 不再自行 compile，普通业务只处理 input + config + context。NodeRegistry 的非 action 声明由独立结构策略处理，不伪装普通操作。createOperationNodeType 仅组合业务实现；invokeNodeOperation 保留独立真实值校验，不承担调度、Binding 或持久化。

DataTypeRegistry 的公开副本不含 Zod。isTypeAssignable 重导出共享纯函数，前后端采用相同规则。RuntimeValue 包含实际类型与承载方式，NodeOutputMap 不使用 unknown 代替结果。

BindingResolver 按 Manifest 组装 RuntimeValue，Decode 只返回 inline 值或委托引用服务。Action NodeExecutor 串联精确 Registry、绑定、decode、三组 Schema 和业务调用，只返回业务 output，编译包装也不将其冒充 State 增量。引用解析、输出编码、内容 / 审计尚无生产实现，不提供内存、本地文件或默认模型兜底。State 无生产 reducer、图运行接口或持久 checkpointer；MemorySaver 和测试实现不作为生产能力。

详细说明见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md)、[Runtime](../../docs/runtime-architecture.md)、[当前架构](../../docs/architecture.md) 与 [实施方案](../../docs/implementation-plan.md)。

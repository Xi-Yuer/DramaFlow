# @dramaflow/workflow

服务端数据与节点基础库：

| 目录       | 职责                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| definition | 显式输入输出值校验、版本快照与运行版本归属                                                               |
| data       | DataTypeDefinition / Registry，递归真实值 Zod 校验                                                       |
| node       | NodeType.execute、精确版本 Registry、值 Schema 与 Preset 校验                                            |
| runtime    | WorkflowState Annotation / outputs reducer、输入组装、Codec 与 Action 输出编码，引用 / Artifact 服务接口 |
| compiler   | 普通 Action 整图组装、薄 action 包装、Data / Control Edge 依赖收集与 ALL Join 编译                       |
| run        | WorkflowRunner start / resume、版本读取 / 运行 Repository 边界、最终输出解析和显式 thread 配置映射       |

NodeType 不再自行 compile，普通业务只处理 input + config + context。NodeRegistry 的非 action 声明由独立结构策略处理，不伪装普通操作。createOperationNodeType 仅组合业务实现；invokeNodeOperation 保留独立真实值校验，不承担调度、Binding 或持久化。

DataTypeRegistry 的公开副本不含 Zod。isTypeAssignable 重导出共享纯函数，前后端采用相同规则。RuntimeValue 包含实际类型与承载方式，NodeOutputMap 不使用 unknown 代替结果。

BindingResolver 按 Manifest 组装 RuntimeValue，Decode 只返回 inline 值或委托引用服务。Action NodeExecutor 先创建 NodeRun，再串联精确 Registry、绑定、记录 RuntimeValue 输入、decode、三组 Schema、业务调用、逐端口 encode 和完成记录，返回 RuntimeValue map，编译包装只返回当前节点的 outputs 增量，由既有 State 模块的 reducer 合并，重复 nodeId 写入明确失败。auto 通过统一类型规则选择 inline / reference，引用输出仅经注入的 ArtifactWriter 写入。run/node-run-repository.ts 的 NodeRunRepository 强制注入，createRunning 只接收 workflowRunId / nodeId，由 API 的 PostgreSQL 实现原子分配 attempt 并保存历史；引用解析、Artifact 写入与内容服务尚无生产实现，不提供内存、本地文件或默认模型兜底。生产持久 Checkpointer 归 packages/server，尚无完整图运行接口；MemorySaver 和测试节点不作为生产能力。

DefaultWorkflowRunner.start 只接受项目 / 工作流 / 版本 ID 和 RuntimeValue 输入，经 WorkflowVersionRepository.getVersion 校验归属并冻结定义，create pending → compile → running → invoke，再检查原生 snapshot。版本不存在或无权访问返回 null，Runner 在创建运行前拒绝。正常结束只保存声明的最终输出，interrupt / pending tasks 记 waiting，执行错误记 failed；不实现 cancel / retry。API 已提供只读 Prisma 版本 Repository，读取完整不可变快照并检查项目权限；workflow 包仍不依赖 Prisma。DefaultWorkflowCompiler 显式接收 Executor 工厂与 BaseCheckpointSaver，并传给 graph.compile；集成测试注入共享服务的官方 PostgresSaver，Compiler 不负责创建或初始化。生产 Runner 装配和运行 HTTP / worker 入口尚未接入。

resume 只接收 workflowRunId / unknown value，从 Repository 读取 waiting Run，以原版本重新编译、原子 claim 为 running，再向原 thread 发送 Command；不创建初始 State 或新 Run。读取 / claim 在 API 的持久化实现中检查项目与所有者，竞争失败不 invoke。start / resume 共用终态处理，Runner 不处理 Human Review 的 NodeRun 恢复关联，原 checkpoint 不可用时不从头重跑。

详细说明见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md)、[Runtime](../../docs/runtime-architecture.md)、[当前架构](../../docs/architecture.md) 与 [实施方案](../../docs/implementation-plan.md)。

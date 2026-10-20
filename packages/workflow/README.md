# @dramaflow/workflow

服务端数据与节点基础库：

| 目录       | 职责                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| definition | 显式输入输出值校验、版本快照与运行版本归属                                                                            |
| data       | DataTypeDefinition / Registry，递归真实值 Zod 校验                                                                    |
| node       | NodeType.execute、精确版本 Registry、值 Schema 与 Preset 校验                                                         |
| runtime    | WorkflowState Annotation / outputs reducer、输入组装、Codec 与 Action 输出编码，引用 / Artifact 服务接口              |
| compiler   | 普通 Action 整图组装、薄 action 包装、Data / Control Edge 依赖收集与 ALL Join 编译                                    |
| run        | Submission / Runner executeStart / executeResume、版本读取 / 运行 Repository 边界、最终输出解析和显式 thread 配置映射 |

NodeType 不再自行 compile，普通业务只处理 input + config + context。NodeRegistry 的非 action 声明由独立结构策略处理，不伪装普通操作。createOperationNodeType 仅组合业务实现；invokeNodeOperation 保留独立真实值校验，不承担调度、Binding 或持久化。

DataTypeRegistry 的公开副本不含 Zod。isTypeAssignable 重导出共享纯函数，前后端采用相同规则。RuntimeValue 包含实际类型与承载方式，NodeOutputMap 不使用 unknown 代替结果。

BindingResolver 按 Manifest 组装 RuntimeValue，Decode 只返回 inline 值或委托引用服务。Action NodeExecutor 先创建 NodeRun，再串联精确 Registry、绑定、记录 RuntimeValue 输入、decode、三组 Schema、业务调用、逐端口 encode 和完成记录，返回 RuntimeValue map，编译包装只返回当前节点的 outputs 增量，由既有 State 模块的 reducer 合并，重复 nodeId 写入明确失败。auto 通过统一类型规则选择 inline / reference，引用输出仅经注入的 ArtifactWriter 写入。run/node-run-repository.ts 的 NodeRunRepository 强制注入，createRunning 只接收 workflowRunId / nodeId，由共享服务的 PostgreSQL 实现原子分配 attempt 并保存历史；引用解析、Artifact 写入与内容服务尚无生产实现，不提供内存、本地文件或默认模型兜底。生产持久 Checkpointer 归 packages/server，API 已提供 Run HTTP，Worker 已接入队列消费者；MemorySaver 和测试节点不作为生产能力。

DefaultWorkflowRunSubmissionService.start 只接受项目 / 工作流 / 明确版本和 RuntimeValue 输入，核对版本归属后经 SubmissionRepository 原子创建 pending 与 Outbox；resume 原子检查 waiting 周期并持久创建独立 executionId 意图，不执行、不 claim。提交不依赖 Redis / BullMQ，投递由 server 层 Dispatcher 承担。

DefaultWorkflowRunner.executeStart(id) / executeResume({ workflowRunId, value }) 只执行已有 Run；实际执行者先原子 claim pending / waiting，再从原记录加载固定版本并编译，thread 和输入均取持久记录，不创建第二条 Run。首次 claim 写 startedAt，恢复保留它。两个入口共用结果处理，原生暂停记 waiting，END 时只解析并保存声明的最终输出。准备 / 执行失败由 claim 胜者记 failed，记录故障不反向写失败；恢复不初始化 State、不自动重跑。

共享服务有生产 Prisma Repository、SubmissionFactory、ExecutionService 和应用级官方 PostgresSaver，API 只事务提交并确认入队，Worker 消费 Job。Job 只含 kind / workflowRunId / 恢复 executionId 与 value，不复制 Definition、State 或 thread。生产 Registry 仍为空，Runner 不处理 Human Review NodeRun 恢复关联。
详细说明见 [数据模型](../../docs/data-model.md)、[Node](../../docs/node-model.md)、[Runtime](../../docs/runtime-architecture.md)、[当前架构](../../docs/architecture.md) 与 [实施方案](../../docs/implementation-plan.md)。

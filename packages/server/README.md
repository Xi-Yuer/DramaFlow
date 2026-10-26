# @dramaflow/server

API 与 Worker 共用的基础设施：PostgreSQL、官方 LangGraph Checkpointer、Redis、RustFS、凭证加密，以及 Run、Artifact 和模型的生产装配。不含 HTTP 路由和节点业务。

`workflow/` 按职责分目录，根上不再混放 Registry、仓储、受理和审核。

| 目录                       | 职责                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| workflow/node              | 生产 Node Registry 装配。目录与执行共用，注册不等于允许发布       |
| workflow/run/repository    | 授权范围内的 WorkflowRun 与 WorkflowVersion 端口                  |
| workflow/run/submission    | 受理装配。不构造 Compiler、Runner 或 Checkpointer                 |
| workflow/run/query         | 已授权 Run 的只读投影。不创建运行、不写 Outbox、不入队            |
| workflow/runtime           | 执行装配与 Worker 执行服务                                        |
| workflow/runtime/execution | NodeRun、ChildExecution、Iteration 与 Human Review 审计的授权实现 |
| workflow/human-review      | 待审批查询与恢复前的 checkpoint 校验                              |
| workflow/execution-tree    | 只读执行树查询与 Prisma 适配                                      |
| workflow/queue             | 持久投递、Outbox 与消费                                           |

artifacts、models、storage、checkpoint 仍按各自领域组织。Checkpointer、队列和模型管理见 [部署](../../docs/deployment.md) 与 [当前架构](../../docs/architecture.md)。

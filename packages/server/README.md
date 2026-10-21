# @dramaflow/server

API 与 worker 共用的服务端基础设施及 Runtime 装配适配：PostgreSQL、官方 LangGraph PostgreSQL Checkpointer、Redis、RustFS / S3 和凭证加密。不包含 HTTP 路由、认证入口或节点业务逻辑。

WorkflowCheckpointerModule 提供应用级 WorkflowCheckpointerService。它以 DATABASE_URL 创建独立 pg 连接池，在 Nest 初始化期间串行调用官方 PostgresSaver.setup() 并验证读取，成功后才开放 saver，关闭应用时调用 end()。checkpoint 位于独立 langgraph schema，由官方维护表和序列化，不进入 Prisma。Compiler 接收 service.saver，不创建连接或执行 setup；没有 MemorySaver 生产回退。初始化失败阻止应用就绪，健康检查验证官方读取路径。配置与备份见 [部署说明](../../docs/deployment.md#langgraph-postgresql-checkpointer)。

对象存储只提供连接探测和对象读写，素材版本与权限不在这里。凭证密文用所有者标识做附加认证数据。

workflow/ 保存 API / Worker 共用的生产 Prisma Repository 工厂与小型 Runtime 装配 factory。WorkflowRuntimeInfrastructureModule 连接真实版本读取、Run / NodeRun、Codec、存储策略、输出解析及 PostgresSaver；WorkflowRuntimeFactory.forProject(ownerId, projectId) 返回限定权限的 Runner。WorkflowRunSubmissionFactory.forProject 只构造提交服务，不依赖 Compiler / Checkpointer；WorkflowExecutionService 是受信任的 Job 执行端，按 Run ID 读取项目 / 所有者后构造 Runner，不能替代 HTTP 权限检查。应用 Service 仍分别归 API / Worker；本包不包含 HTTP 路由，Consumer / OutboxPump 由 Worker 模块注册，API 只引入 SubmissionModule / QueueModule。WorkflowNodeRegistryModule 让目录与 Runtime 共用正式文本节点 Registry。内容引用与 Artifact 写入使用生产对象存储实现，不提供内存或本地内容兜底；边界见[当前架构](../../docs/architecture.md#artifact-生产数据通道)。

workflow/queue 使用 BullMQ 6.3.18 和独立 Redis 连接 / prefix。WorkflowOutboxDispatcher 在行锁事务内 enqueue 后记 published；WorkflowExecutionConsumer 按持久意图身份校验再执行，业务终态用 UnrecoverableError 阻止业务重跑；claim 前基础设施故障可退避重试，claim 后结果不明记 recovery_required。配置、保留与故障边界见 [部署](../../docs/deployment.md#workflow-执行队列)和[架构](../../docs/architecture.md#workflow-execution-queue)。

`models/ModelProviderService` 复用正式 PluginRegistry / Schema，提供项目所有者隔离的 Provider / 模型创建、安全读取 / 有界分页、enabled 原子更新及凭证完整轮换。读取投影不包含密文，调用前才解密；API 负责 HTTP DTO 和错误脱敏，Worker 继续复用相同绑定。详细边界见[模型管理](../../docs/architecture.md#plugin--provider--模型配置管理-http)。

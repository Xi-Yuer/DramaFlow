# @dramaflow/server

API 与 worker 共用的服务端基础设施及 Runtime 装配适配：PostgreSQL、官方 LangGraph PostgreSQL Checkpointer、Redis、RustFS / S3 和凭证加密。不包含 HTTP 路由、认证入口或节点业务逻辑。

WorkflowCheckpointerModule 提供应用级 WorkflowCheckpointerService。它以 DATABASE_URL 创建独立 pg 连接池，在 Nest 初始化期间串行调用官方 PostgresSaver.setup() 并验证读取，成功后才开放 saver，关闭应用时调用 end()。checkpoint 位于独立 langgraph schema，由官方维护表和序列化，不进入 Prisma。Compiler 接收 service.saver，不创建连接或执行 setup；没有 MemorySaver 生产回退。初始化失败阻止应用就绪，健康检查验证官方读取路径。配置与备份见 [部署说明](../../docs/deployment.md#langgraph-postgresql-checkpointer)。

对象存储只提供连接探测和对象读写，素材版本与权限不在这里。凭证密文用所有者标识做附加认证数据。

workflow/ 保存 API / Worker 共用的生产 Prisma Repository 工厂与小型 Runtime 装配 factory。WorkflowRuntimeInfrastructureModule 连接真实版本读取、Run / NodeRun、Codec、存储策略、输出解析及 PostgresSaver；WorkflowRuntimeFactory.forProject(ownerId, projectId) 返回限定权限的 Runner。应用 Service 仍分别归 API / Worker，不提供 HTTP 或队列入口。WorkflowNodeRegistryModule 让目录与 Runtime 共用生产 Registry，当前为空。内容引用及 Artifact 写入只有明确拒绝适配，错误码为 REFERENCE_RUNTIME_NOT_CONFIGURED / ARTIFACT_WRITER_NOT_CONFIGURED，前者通过 Codec 的 cause 保留，不提供内容兜底。

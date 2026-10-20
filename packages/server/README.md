# @dramaflow/server

API 与 worker 共用的服务端基础设施：PostgreSQL、官方 LangGraph PostgreSQL Checkpointer、Redis、RustFS / S3 和凭证加密。不包含 HTTP 路由、认证或业务流程。

WorkflowCheckpointerModule 提供应用级 WorkflowCheckpointerService。它以 DATABASE_URL 创建独立 pg 连接池，在 Nest 初始化期间串行调用官方 PostgresSaver.setup() 并验证读取，成功后才开放 saver，关闭应用时调用 end()。checkpoint 位于独立 langgraph schema，由官方维护表和序列化，不进入 Prisma。Compiler 接收 service.saver，不创建连接或执行 setup；没有 MemorySaver 生产回退。初始化失败阻止应用就绪，健康检查验证官方读取路径。配置与备份见 [部署说明](../../docs/deployment.md#langgraph-postgresql-checkpointer)。

对象存储只提供连接探测和对象读写，素材版本与权限不在这里。凭证密文用所有者标识做附加认证数据。

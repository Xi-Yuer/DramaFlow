# @dramaflow/server

API 与 Worker 共用的基础设施：PostgreSQL、官方 LangGraph Checkpointer、Redis、RustFS、凭证加密，以及 Run、Artifact 和模型的生产装配。不含 HTTP 路由和节点业务。

Checkpointer、队列和模型管理见 [部署](../../docs/deployment.md) 与 [当前架构](../../docs/architecture.md)。

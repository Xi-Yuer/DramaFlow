# 当前基础架构

当前阶段只维护工程和基础设施，不实现业务。此前工作流、节点、插件、模型调用、会话、权限及素材业务代码均已删除。

Next.js 使用 App Router、Ant Design 和 TanStack Query Provider；同源 /api/v1 代理到 NestJS。API 仅暴露健康检查。worker 是独立 NestJS 进程，复用 API 导出的 infrastructure 模块连接 PostgreSQL、Redis 和 RustFS，不消费旧队列任务。

PostgreSQL 使用 pgvector 镜像和 Prisma；当前 schema 没有业务模型，迁移只启用 vector 扩展。Redis 与 BullMQ 依赖保留用于后续任务基础，当前不定义任务协议。RustFS 通过官方 S3 SDK 提供基础读写，没有资产版本、权限、生成或下载业务接口。

contracts、workflow、plugins、context 保留包目录、构建配置和空入口，不提供假实现。LangChain、LangGraph、React Flow 等已选技术依赖保留，实际接入方式等待用户逐步指导。

已确认的长期业务约束保留在 AGENTS.md，属于后续设计依据，不代表当前已交付业务功能。

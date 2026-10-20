# worker

独立 NestJS 应用上下文，通过 `@dramaflow/server` 接入基础设施，启动期间初始化应用级官方 PostgreSQL Checkpointer，并验证数据库、checkpoint、Redis 与对象存储可用；关闭时释放连接。与 API 使用相同 DATABASE_URL 的 langgraph schema，workflow/runtime 的应用 Service 已通过共享 factory 装配生产 Runner，start 显式传入所有者与版本输入，resume 显式传入所有者 / 项目及原运行 ID；仍未注册或消费业务任务。执行进程的职责边界见 [当前架构](../../docs/architecture.md)。

启动与检查见 [根 README](../../README.md) 和 [开发指南](../../docs/development.md)，当前阶段与后续实施范围见 [分步设计与实施方案](../../docs/implementation-plan.md)。
